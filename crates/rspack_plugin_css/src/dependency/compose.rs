use rspack_core::{
  CodeGeneratable, CodeGeneratableContext, CodeGeneratableResult, Dependency, DependencyCategory,
  DependencyId, DependencyType, ErrorSpan, ModuleDependency,
};

#[derive(Debug, Clone)]
pub struct CssComposeDependency {
  id: Option<DependencyId>,
  request: String,
  span: Option<ErrorSpan>,
}

impl CssComposeDependency {
  pub fn new(request: String, span: Option<ErrorSpan>) -> Self {
    Self {
      id: None,
      request,
      span,
    }
  }
}

impl Dependency for CssComposeDependency {
  fn id(&self) -> Option<DependencyId> {
    self.id
  }
  fn set_id(&mut self, id: Option<DependencyId>) {
    self.id = id;
  }

  fn category(&self) -> &DependencyCategory {
    &DependencyCategory::CssCompose
  }

  fn dependency_type(&self) -> &DependencyType {
    &DependencyType::CssCompose
  }
}

impl ModuleDependency for CssComposeDependency {
  fn request(&self) -> &str {
    &self.request
  }

  fn user_request(&self) -> &str {
    &self.request
  }

  fn span(&self) -> Option<&ErrorSpan> {
    self.span.as_ref()
  }

  fn set_request(&mut self, request: String) {
    self.request = request;
  }
}

impl CodeGeneratable for CssComposeDependency {
  fn generate(
    &self,
    _code_generatable_context: &mut CodeGeneratableContext,
  ) -> rspack_error::Result<CodeGeneratableResult> {
    Ok(CodeGeneratableResult::default())
  }
}
