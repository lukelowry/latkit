//! Remove unreachable constant branches before translating a shader for the driver.

use naga::{Block, Expression, Literal, Statement};

/// Keep exactly one shader stage and entry point. GLSL translation otherwise emits regular
/// functions used only by other entry points when they happen to read the same resources.
pub(crate) fn entry(mut source: naga::Module, name: &str) -> naga::Module {
    source.entry_points.retain(|entry| entry.name == name);
    module(source)
}

fn literal(
    expression: &Expression,
    expressions: &naga::Arena<Expression>,
    constants: &[Option<Literal>],
) -> Option<Literal> {
    use naga::{BinaryOperator as B, UnaryOperator as U};
    let value = |handle| literal(&expressions[handle], expressions, constants);
    match *expression {
        Expression::Literal(value) => Some(value),
        Expression::Constant(handle) => constants[handle.index()],
        Expression::Unary { op: U::LogicalNot, expr } => match value(expr)? {
            Literal::Bool(value) => Some(Literal::Bool(!value)),
            _ => None,
        },
        Expression::Binary { op, left, right } => {
            let (left, right) = (value(left)?, value(right)?);
            let (equal, order) = match (left, right) {
                (Literal::Bool(a), Literal::Bool(b)) => {
                    return match op {
                        B::LogicalAnd => Some(Literal::Bool(a && b)),
                        B::LogicalOr => Some(Literal::Bool(a || b)),
                        B::Equal => Some(Literal::Bool(a == b)),
                        B::NotEqual => Some(Literal::Bool(a != b)),
                        _ => None,
                    };
                }
                (Literal::U32(a), Literal::U32(b)) => (a == b, a.partial_cmp(&b)),
                (Literal::I32(a), Literal::I32(b)) => (a == b, a.partial_cmp(&b)),
                (Literal::F32(a), Literal::F32(b)) => (a == b, a.partial_cmp(&b)),
                _ => return None,
            };
            Some(Literal::Bool(match op {
                B::Equal => equal,
                B::NotEqual => !equal,
                B::Less => order.is_some_and(std::cmp::Ordering::is_lt),
                B::LessEqual => order.is_some_and(std::cmp::Ordering::is_le),
                B::Greater => order.is_some_and(std::cmp::Ordering::is_gt),
                B::GreaterEqual => order.is_some_and(std::cmp::Ordering::is_ge),
                _ => return None,
            }))
        }
        _ => None,
    }
}

// A specialized helper such as geographic() can become a literal return. Calls to it
// still obstruct pruning unless the result is propagated before examining its caller.
// Only functions made entirely of expression emission and one literal return qualify:
// stores, image writes, discard, and all remaining control flow prevent substitution.
fn returned(body: &Block, expressions: &naga::Arena<Expression>, constants: &[Option<Literal>]) -> Option<Literal> {
    for statement in body {
        match statement {
            Statement::Emit(_) => {}
            Statement::Block(inner) if inner.is_empty() => {}
            Statement::Block(inner) => return returned(inner, expressions, constants),
            Statement::Return { value: Some(value) } => {
                return literal(&expressions[*value], expressions, constants);
            }
            _ => return None,
        }
    }
    None
}

fn calls(body: &mut Block, expressions: &mut naga::Arena<Expression>, returned: &[Option<Literal>]) {
    for statement in body.iter_mut() {
        if let Statement::Call { function, result: Some(result), .. } = statement
            && let Some(value) = returned.get(function.index()).copied().flatten()
        {
            expressions[*result] = Expression::Literal(value);
            *statement = Statement::Block(Block::new());
        }
        match statement {
            Statement::Block(inner) => calls(inner, expressions, returned),
            Statement::If { accept, reject, .. } => {
                calls(accept, expressions, returned);
                calls(reject, expressions, returned);
            }
            Statement::Switch { cases, .. } => {
                for case in cases {
                    calls(&mut case.body, expressions, returned);
                }
            }
            Statement::Loop { body, continuing, .. } => {
                calls(body, expressions, returned);
                calls(continuing, expressions, returned);
            }
            _ => {}
        }
    }
}
fn breaks(body: &Block) -> bool {
    body.iter().any(|statement| match statement {
        Statement::Break => true,
        Statement::Block(body) => breaks(body),
        Statement::If { accept, reject, .. } => breaks(accept) || breaks(reject),
        // Breaks inside nested loops or switches belong to those constructs.
        _ => false,
    })
}
fn returns(statement: &Statement) -> bool {
    match statement {
        Statement::Return { .. } | Statement::Kill | Statement::Break | Statement::Continue => true,
        Statement::Block(body) => body.last().is_some_and(returns),
        _ => false,
    }
}
fn block(body: &mut Block, expressions: &naga::Arena<Expression>, constants: &[Option<Literal>]) {
    for statement in body.iter_mut() {
        if let Statement::If { condition, accept, reject } = statement {
            let value = literal(&expressions[*condition], expressions, constants);
            if let Some(Literal::Bool(value)) = value {
                *statement = Statement::Block(std::mem::take(if value { accept } else { reject }));
            }
        }
        if let Statement::Switch { selector, cases } = statement {
            let value = match literal(&expressions[*selector], expressions, constants) {
                Some(Literal::U32(value)) => Some(naga::SwitchValue::U32(value)),
                Some(Literal::I32(value)) => Some(naga::SwitchValue::I32(value)),
                _ => None,
            };
            if let Some(value) = value {
                let selected = cases
                    .iter()
                    .position(|case| case.value == value)
                    .or_else(|| cases.iter().position(|case| case.value == naga::SwitchValue::Default));
                if let Some(i) = selected.filter(|&i| !cases[i].fall_through && !breaks(&cases[i].body)) {
                    *statement = Statement::Block(std::mem::take(&mut cases[i].body));
                }
            }
        }
        match statement {
            Statement::Block(inner) => block(inner, expressions, constants),
            Statement::If { accept, reject, .. } => {
                block(accept, expressions, constants);
                block(reject, expressions, constants);
            }
            Statement::Switch { cases, .. } => {
                for case in cases {
                    block(&mut case.body, expressions, constants);
                }
            }
            Statement::Loop { body, continuing, .. } => {
                block(body, expressions, constants);
                block(continuing, expressions, constants);
            }
            _ => {}
        }
    }
    if let Some(last) = body.iter().position(returns) {
        body.cull(last + 1..);
    }
}
/// Prune a parsed module. The caller validates the result before use.
pub(crate) fn module(mut module: naga::Module) -> naga::Module {
    let constants: Vec<_> = module
        .constants
        .iter()
        .map(|(_, c)| match module.global_expressions[c.init] {
            Expression::Literal(value) => Some(value),
            _ => None,
        })
        .collect();
    // Naga orders functions before their callers, so one pass propagates through helper chains.
    // Calls to the functions expression kernels call (`k_`, see `lib/evaluate.wesl`) stay, since a
    // kernel written after translation calls them by name.
    let mut returned_values = Vec::with_capacity(module.functions.len());
    for (_, function) in module.functions.iter_mut() {
        calls(&mut function.body, &mut function.expressions, &returned_values);
        block(&mut function.body, &function.expressions, &constants);
        let interface = function.name.as_deref().is_some_and(|name| name.starts_with("k_"));
        returned_values.push(if interface {
            None
        } else {
            returned(&function.body, &function.expressions, &constants)
        });
        // Names retain otherwise-dead expressions during compaction, including results of calls
        // in removed branches. They are debug labels, not shader semantics.
        function.named_expressions.clear();
    }
    for entry in &mut module.entry_points {
        calls(&mut entry.function.body, &mut entry.function.expressions, &returned_values);
        block(&mut entry.function.body, &entry.function.expressions, &constants);
        entry.function.named_expressions.clear();
    }
    naga::compact::compact(&mut module, naga::compact::KeepUnused::No);
    module
}

#[cfg(test)]
mod tests {
    #[test]
    fn literal_helpers_prune_callers_without_erasing_side_effects() {
        let source = r"
const PLANAR: bool = true;
@group(0) @binding(0) var<uniform> value: vec4f;
var<private> touches: u32;
fn geographic() -> bool { if PLANAR { return false; } return true; }
fn radius() -> f32 { if PLANAR { return 0.0; } return 2.0; }
fn chained() -> bool { return !geographic(); }
fn expensive() -> f32 { return length(value); }
fn counted() -> bool { touches += 1u; return false; }
@fragment fn pure() -> @location(0) vec4f {
    var x = 1.0;
    if geographic() { x = expensive(); }
    if radius() > 0.0 { x += expensive(); }
    if chained() { x += 1.0; }
    return vec4f(x);
}
@fragment fn effects() -> @location(0) vec4f {
    let result = counted();
    return vec4f(f32(touches), select(0.0, 1.0, result), 0.0, 1.0);
}
";
        let source = naga::front::wgsl::parse_str(source).expect("valid WGSL");
        for (name, functions) in [("pure", 0), ("effects", 1)] {
            let selected = super::entry(source.clone(), name);
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
                .validate(&selected)
                .expect("literal substitution preserves expression scopes and side effects");
            assert_eq!(selected.functions.len(), functions);
        }
    }

    #[test]
    fn entries_keep_only_their_own_reachable_functions() {
        let source = r"
@group(0) @binding(0) var<uniform> value: vec4f;
fn position() -> vec4f { return value; }
fn color() -> vec4f { return value * 0.5; }
fn alternate_color() -> vec4f { return value * 0.25; }
@vertex fn vertex() -> @builtin(position) vec4f { return position(); }
@fragment fn fragment() -> @location(0) vec4f { return color(); }
@fragment fn alternate() -> @location(0) vec4f { return alternate_color(); }
";
        let module = naga::front::wgsl::parse_str(source).expect("valid WGSL");
        for (entry, function) in [("vertex", "position"), ("fragment", "color"), ("alternate", "alternate_color")] {
            let selected = super::entry(module.clone(), entry);
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
                .validate(&selected)
                .expect("entry isolation preserves valid WGSL");
            assert_eq!(selected.entry_points.len(), 1);
            assert_eq!(selected.functions.len(), 1);
            assert_eq!(
                selected.functions.iter().next().expect("a reachable function").1.name.as_deref(),
                Some(function)
            );
        }
    }
}
