use rayon::prelude::*;
use rspack_core::{Chunk, ChunkUkey, Compilation};
use rustc_hash::FxHashSet;

use crate::module_group::ModuleGroup;
use crate::SplitChunksPlugin;

impl SplitChunksPlugin {
  /// Affected by `splitChunks.cacheGroups.{cacheGroup}.reuseExistingChunk`
  ///
  /// If the current chunk contains modules already split out from the main bundle,
  /// it will be reused instead of a new one being generated. This can affect the
  /// resulting file name of the chunk.
  ///
  /// the best means the reused chunks contains all modules in this ModuleGroup
  pub(crate) fn find_the_best_reusable_chunk(
    &self,
    compilation: &mut Compilation,
    module_group: &mut ModuleGroup,
  ) -> Option<ChunkUkey> {
    let candidates = module_group.chunks.par_iter().filter_map(|chunk| {
      let chunk = chunk.as_ref(&compilation.chunk_by_ukey);

      if compilation
        .chunk_graph
        .get_number_of_chunk_modules(&chunk.ukey)
        != module_group.modules.len()
      {
        // Fast path for checking is the chunk reuseable for this `ModuleGroup`.
        return None;
      }

      if module_group.chunks.len() > 1
        && compilation
          .chunk_graph
          .get_number_of_entry_modules(&chunk.ukey)
          > 0
      {
        // `module_group.chunks.len() > 1`: this ModuleGroup are related multiple chunks generated in code splitting.
        // `get_number_of_entry_modules(&chunk.ukey) > 0`:  current chunk is an initial chunk.

        // I(hyf0) don't see why breaking for this condition. But ChatGPT3.5 told me:

        // The condition means that if there are multiple chunks in item and the current chunk is an
        // entry chunk, then it cannot be reused. This is because entry chunks typically contain the core
        // code of an application, while other chunks contain various parts of the application. If
        // an entry chunk is used for other purposes, it may cause the application broken.
        return None;
      }

      let is_all_module_in_chunk = module_group.modules.par_iter().all(|each_module| {
        compilation
          .chunk_graph
          .is_module_in_chunk(each_module, chunk.ukey)
      });
      if !is_all_module_in_chunk {
        return None;
      }

      Some(chunk)
    });

    /// Port https://github.com/webpack/webpack/blob/b471a6bfb71020f6d8f136ef10b7efb239ef5bbf/lib/optimize/SplitChunksPlugin.js#L1360-L1373
    fn best_reuseable_chunk<'a>(first: &'a Chunk, second: &'a Chunk) -> &'a Chunk {
      match (&first.name, &second.name) {
        (None, None) => first,
        (None, Some(_)) => second,
        (Some(_), None) => first,
        (Some(first_name), Some(second_name)) => match first_name.len().cmp(&second_name.len()) {
          std::cmp::Ordering::Greater => second,
          std::cmp::Ordering::Less => first,
          std::cmp::Ordering::Equal => {
            if matches!(second_name.cmp(first_name), std::cmp::Ordering::Less) {
              second
            } else {
              first
            }
          }
        },
      }
    }

    let best_reuseable_chunk =
      candidates.reduce_with(|best, each| best_reuseable_chunk(best, each));

    best_reuseable_chunk.map(|c| c.ukey)
  }

  pub(crate) fn get_corresponding_chunk(
    &self,
    compilation: &mut Compilation,
    module_group: &mut ModuleGroup,
    is_reuse_existing_chunk: &mut bool,
    is_reuse_existing_chunk_with_all_modules: &mut bool,
  ) -> ChunkUkey {
    if let Some(chunk_name) = &module_group.chunk_name {
      if let Some(chunk) = compilation.named_chunks.get(chunk_name) {
        *is_reuse_existing_chunk = true;
        *chunk
      } else {
        let new_chunk = Compilation::add_named_chunk(
          chunk_name.clone(),
          &mut compilation.chunk_by_ukey,
          &mut compilation.named_chunks,
        );
        new_chunk
          .chunk_reasons
          .push("Create by split chunks".to_string());
        compilation.chunk_graph.add_chunk(new_chunk.ukey);
        new_chunk.ukey
      }
    } else if let Some(reusable_chunk) = self.find_the_best_reusable_chunk(compilation, module_group)
      && module_group.cache_group_reuse_existing_chunk
    {
      *is_reuse_existing_chunk = true;
      *is_reuse_existing_chunk_with_all_modules = true;
      reusable_chunk
    } else {
      let new_chunk = Compilation::add_chunk(&mut compilation.chunk_by_ukey);
      new_chunk
        .chunk_reasons
        .push("Create by split chunks".to_string());
      compilation.chunk_graph.add_chunk(new_chunk.ukey);
      new_chunk.ukey
    }
  }

  /// This de-duplicated each module fro other chunks, make sure there's only one copy of each module.
  #[tracing::instrument(skip_all)]
  pub(crate) fn move_modules_to_new_chunk_and_remove_from_old_chunks(
    &self,
    item: &ModuleGroup,
    new_chunk: ChunkUkey,
    original_chunks: &FxHashSet<ChunkUkey>,
    compilation: &mut Compilation,
  ) {
    for module_identifier in &item.modules {
      // First, we remove modules from old chunks

      // Remove module from old chunks
      for used_chunk in original_chunks {
        compilation
          .chunk_graph
          .disconnect_chunk_and_module(used_chunk, *module_identifier);
      }

      // Add module to new chunk
      compilation
        .chunk_graph
        .connect_chunk_and_module(new_chunk, *module_identifier);
    }
  }

  /// Since the modules are moved into the `new_chunk`, we should
  /// create a connection between the `new_chunk` and `original_chunks`.
  /// Thus, if `original_chunks` want to know which chunk contains moved modules,
  /// it could easily find out.
  #[tracing::instrument(skip_all)]
  pub(crate) fn split_from_original_chunks(
    &self,
    _item: &ModuleGroup,
    original_chunks: &FxHashSet<ChunkUkey>,
    new_chunk: ChunkUkey,
    compilation: &mut Compilation,
  ) {
    let new_chunk_ukey = new_chunk;
    for original_chunk in original_chunks {
      debug_assert!(&new_chunk_ukey != original_chunk);
      let [new_chunk, original_chunk] = compilation
        .chunk_by_ukey
        ._todo_should_remove_this_method_inner_mut()
        .get_many_mut([&new_chunk_ukey, original_chunk])
        .expect("split_from_original_chunks failed");
      original_chunk.split(new_chunk, &mut compilation.chunk_group_by_ukey);
    }
  }
}
