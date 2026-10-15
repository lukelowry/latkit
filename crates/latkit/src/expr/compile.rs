//! Expressions to bytecode: each channel of a mark is a range of ops that ends in a store.
//!
//! Compilation type-checks against the data's fields and records what each channel depends on, so
//! the view evaluates a channel only when one of its inputs changes.

use std::ops::BitOr;
use std::sync::Arc;

use super::{Binary, Colormap, Domain, Expr, FieldRef, Node, State, Unary};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

/// What a channel reads, so the view knows when to evaluate it again.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Deps(u8);

impl Deps {
    pub(crate) const DATA: Deps = Deps(1);
    pub(crate) const SAMPLES: Deps = Deps(2);
    pub(crate) const TIME: Deps = Deps(4);
    pub(crate) const POINTER: Deps = Deps(8);
    pub(crate) const FOCUS: Deps = Deps(16);
    pub(crate) const DOMAIN: Deps = Deps(32);
    pub(crate) const CAMERA: Deps = Deps(64);

    pub(crate) fn intersects(self, other: Deps) -> bool {
        self.0 & other.0 != 0
    }
}

impl BitOr for Deps {
    type Output = Deps;

    fn bitor(self, other: Deps) -> Deps {
        Deps(self.0 | other.0)
    }
}

impl std::ops::BitOrAssign for Deps {
    fn bitor_assign(&mut self, other: Deps) {
        self.0 |= other.0;
    }
}

/// Which words of a column's pages a program reads.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Part {
    /// Numbers as `f32`, booleans as 0 or 1.
    Values,
    /// Text as dictionary codes.
    Codes,
    /// Reference rows as `u32`, `NONE` where unwired.
    Bits,
    /// A point's x.
    X,
    /// A point's y.
    Y,
    /// A geometry's points per row: a page's row count, each row's first point and the end, then
    /// every point's x and y; parts are broken by a missing point.
    Path,
}

/// A column a program reads: of the mark's own table, of another dataset's table joined by row id,
/// or of the table the view derives beside the mark's own, row for row.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct ColumnUse {
    pub(crate) of: Option<(Name, Name)>,
    pub(crate) derived: bool,
    pub(crate) name: Name,
    pub(crate) part: Part,
    pub(crate) sampled: bool,
    pub(crate) step: bool,
    /// Also read the part `f32` drops of an `f64`, for positions.
    pub(crate) low: bool,
    /// Read every frame in view, as a line tracing the field does.
    pub(crate) trace: bool,
}

impl ColumnUse {
    /// The mark's own field `name`, read as `part`.
    fn own(name: impl Into<Name>, part: Part) -> ColumnUse {
        ColumnUse {
            of: None,
            derived: false,
            name: name.into(),
            part,
            sampled: false,
            step: false,
            low: false,
            trace: false,
        }
    }

    /// The derived field `name`, read as `part`.
    fn derived(name: impl Into<Name>, part: Part) -> ColumnUse {
        ColumnUse { derived: true, ..ColumnUse::own(name, part) }
    }
}

/// A constant holding a text's dictionary code in a column; the view writes it.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct TextUse {
    pub(crate) constant: u32,
    pub(crate) column: u32,
    pub(crate) text: Arc<str>,
}

/// A mark's compiled channels and what they read.
#[derive(Clone, Default, PartialEq, Debug)]
pub(crate) struct Program {
    pub(crate) code: Vec<[u32; 4]>,
    pub(crate) constants: Vec<u32>,
    /// Op ranges of every channel, then of every reduction.
    pub(crate) ranges: Vec<[u32; 2]>,
    pub(crate) channels: Vec<Channel>,
    /// What each fitted domain's input reads.
    pub(crate) domains: Vec<Reads>,
    pub(crate) columns: Vec<ColumnUse>,
    pub(crate) texts: Vec<TextUse>,
    /// Colormap ops, whose layer the view writes.
    pub(crate) colormaps: Vec<(u32, Colormap)>,
    /// Tables that ends point at, by end index.
    pub(crate) ends: Vec<Name>,
    /// State words stored in position units.
    pub(crate) units: u32,
}

/// What a channel or a fitted domain reads: kinds of input, and which of the program's columns.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct Reads {
    pub(crate) deps: Deps,
    /// Bit `i` for column `i`; the last bit stands for every column past it.
    pub(crate) columns: u64,
}

impl Reads {
    pub(crate) fn column(index: usize) -> u64 {
        1 << index.min(63)
    }
}

#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Channel {
    pub(crate) name: Name,
    pub(crate) reads: Reads,
}

impl Program {
    /// What all channels read together.
    pub(crate) fn reads(&self) -> Deps {
        self.channels.iter().fold(Deps::default(), |all, c| all | c.reads.deps)
    }
}

/// Where a channel stores its value.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Store {
    Number { word: u32, fallback: Option<u32> },
    Size { word: u32, units: bool, fallback: Option<u32> },
    Color { word: u32, fallback: u32 },
    Flag { word: u32, bit: u32 },
}

/// The fields a mark's expressions can read.
pub(crate) trait Fields {
    /// The kind of `name` in the mark's table, or in `of`'s table.
    fn kind(&self, of: Option<&(Name, Name)>, name: &str) -> Option<Kind>;
    /// The table a reference field of the mark's table names.
    fn target(&self, name: &str) -> Option<Name>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ty {
    Number,
    Bool,
    Color,
    Text,
}

const NONE: u32 = wgsl::NONE;

pub(crate) struct Compiler<'a> {
    fields: &'a dyn Fields,
    program: Program,
    depth: u32,
    deps: Deps,
    columns_read: u64,
    /// Code of each fitted domain's reduction, placed after the channels by `finish`.
    reductions: Vec<Vec<[u32; 4]>>,
    reducing: bool,
}

fn invalid(reason: impl Into<std::borrow::Cow<'static, str>>) -> Error {
    Error::invalid(reason)
}

impl<'a> Compiler<'a> {
    pub(crate) fn new(fields: &'a dyn Fields) -> Compiler<'a> {
        Compiler {
            fields,
            program: Program::default(),
            depth: 0,
            deps: Deps::default(),
            columns_read: 0,
            reductions: Vec::new(),
            reducing: false,
        }
    }

    /// The kind of field `name` of the mark's table.
    pub(crate) fn kind(&self, name: &str) -> Option<Kind> {
        self.fields.kind(None, name)
    }

    /// Compiles `expr` into channel `name`, stored by `store`.
    pub(crate) fn channel(&mut self, name: &str, expr: &Expr, store: Store) -> Result<()> {
        let start = self.begin();
        self.store(expr, store).map_err(|e| e.at(name))?;
        self.close(name, start);
        Ok(())
    }

    /// Compiles a position channel. Plain number fields and point fields keep full precision.
    pub(crate) fn position(&mut self, x: &Expr, y: &Expr, word: u32) -> Result<()> {
        let start = self.begin();
        if let (Some(cx), Some(cy)) = (self.plain(x), self.plain(y)) {
            self.deps |= Deps::DATA;
            self.op(wgsl::OP_POSITION, word, cx, cy, 0, 0)?;
        } else {
            self.coordinate(x).map_err(|e| e.at("x"))?;
            self.coordinate(y).map_err(|e| e.at("y"))?;
            self.op(wgsl::OP_STORE_POSITION, word, 0, 0, 2, 0)?;
        }
        self.close("position", start);
        Ok(())
    }

    /// Compiles a position channel reading the place the view derives for each row, at full
    /// precision.
    pub(crate) fn derived_position(&mut self, word: u32) -> Result<()> {
        let start = self.begin();
        let [x, y] =
            ["x", "y"].map(|name| self.column(ColumnUse { low: true, ..ColumnUse::derived(name, Part::Values) }));
        self.deps |= Deps::DATA;
        self.op(wgsl::OP_POSITION, word, x, y, 0, 0)?;
        self.close("position", start);
        Ok(())
    }

    /// Compiles channel `name` storing the number the view derives as field `field`.
    pub(crate) fn derived(&mut self, name: &str, field: &str, store: Store) -> Result<()> {
        let start = self.begin();
        let column = self.column(ColumnUse::derived(field, Part::Values));
        self.deps |= Deps::DATA;
        self.op(wgsl::OP_FIELD, column, 0, 0, 0, 1)?;
        self.store_op(store)?;
        self.close(name, start);
        Ok(())
    }

    /// The program column of the derived number field `field`, which shaders read directly.
    pub(crate) fn derived_number(&mut self, field: &str) -> u32 {
        self.column(ColumnUse::derived(field, Part::Values))
    }

    /// The program column of the derived geometry field `field`, read as points per row.
    pub(crate) fn derived_path(&mut self, field: &str) -> u32 {
        self.column(ColumnUse::derived(field, Part::Path))
    }

    /// The program column of the mark's geometry field `field`, read as points per row.
    pub(crate) fn path(&mut self, field: &str) -> u32 {
        self.column(ColumnUse::own(field, Part::Path))
    }

    /// The program column of the mark's reference field `name`, read as the rows it names.
    pub(crate) fn bits(&mut self, name: &str) -> Result<u32> {
        if self.fields.kind(None, name) != Some(Kind::Reference) {
            return Err(invalid("not a reference field"));
        }
        Ok(self.column(ColumnUse::own(name, Part::Bits)))
    }

    /// Refuses `expr` for option `name` when it reads anything but static fields: the CPU works it
    /// out from the data alone, as it does a row's priority.
    pub(crate) fn check_data(&self, name: &str, expr: &Expr) -> Result<()> {
        match self.unstructural(expr) {
            Some(reason) => Err(invalid(format!("{name} reads data only, not {reason}")).at(name)),
            None => Ok(()),
        }
    }

    /// Refuses `exprs` for option `name` when they read anything but static fields: where a
    /// diagram's rows stand and how large they are is its structure, made from the data alone.
    pub(crate) fn check_structure<'e>(&self, name: &str, exprs: impl IntoIterator<Item = &'e Expr>) -> Result<()> {
        for expr in exprs {
            if let Some(reason) = self.unstructural(expr) {
                return Err(invalid(format!("a diagram's {name} reads data only, not {reason}")).at(name));
            }
        }
        Ok(())
    }

    /// What `expr` reads that structure cannot: view state or a sampled field.
    fn unstructural(&self, expr: &Expr) -> Option<&'static str> {
        match &*expr.0 {
            Node::State(State::Selected | State::Hovered) => Some("selection or hover"),
            Node::State(State::Pointer) => Some("the pointer"),
            Node::State(State::Elapsed) => Some("time"),
            Node::State(State::Zoom) => Some("the zoom"),
            Node::Field(f) if self.fields.kind(f.of.as_ref(), &f.name) == Some(Kind::Sampled) => {
                Some("a sampled field")
            }
            Node::Unary(_, a) | Node::Is(a, _) => self.unstructural(a),
            Node::Binary(_, a, b) => self.unstructural(a).or_else(|| self.unstructural(b)),
            Node::When(c, a, b) => {
                self.unstructural(c).or_else(|| self.unstructural(a)).or_else(|| self.unstructural(b))
            }
            Node::Scale { input, .. } | Node::Colormap { input, .. } => self.unstructural(input),
            _ => None,
        }
    }

    /// Compiles end `index` of an edge: the vertex the reference field `name` names.
    pub(crate) fn end(&mut self, name: &str, word: u32) -> Result<()> {
        let start = self.begin();
        if self.fields.kind(None, name) != Some(Kind::Reference) {
            return Err(invalid("not a reference field").at(name));
        }
        let target = self.fields.target(name).ok_or_else(|| invalid("not a reference field").at(name))?;
        let column = self.column(ColumnUse::own(name, Part::Bits));
        let index = self.program.ends.len() as u32;
        self.program.ends.push(target);
        self.deps |= Deps::DATA;
        self.op(wgsl::OP_STORE_END, word, column, index, 0, 0)?;
        self.close(name, start);
        Ok(())
    }

    /// Compiles channel `name` storing the code of text field `expr` at `word`, and returns the
    /// program column whose dictionary names the codes.
    pub(crate) fn text(&mut self, name: &str, expr: &Expr, word: u32) -> Result<u32> {
        let Node::Field(f) = &*expr.0 else { return Err(invalid("a label's text is a text field").at(name)) };
        if self.fields.kind(f.of.as_ref(), &f.name) != Some(Kind::Text) {
            return Err(invalid("not a text field").at(&f.name).at(name));
        }
        let start = self.begin();
        let column = self.field_column(f, Part::Codes, false);
        self.op(wgsl::OP_FIELD, column, 0, 0, 0, 1)?;
        self.op(wgsl::OP_STORE_CODE, word, 0, 0, 1, 0)?;
        self.close(name, start);
        Ok(column)
    }

    /// The column of sampled field `name` that a line traces over the axis.
    pub(crate) fn trace(&mut self, name: &str) -> Result<u32> {
        if self.fields.kind(None, name) != Some(Kind::Sampled) {
            return Err(invalid("not a sampled field").at(name));
        }
        let use_ = ColumnUse { sampled: true, trace: true, ..ColumnUse::own(name, Part::Values) };
        self.deps |= Deps::SAMPLES;
        Ok(self.column(use_))
    }

    /// The program: channel ranges, then a range per fitted domain's reduction.
    pub(crate) fn finish(mut self) -> Program {
        for code in std::mem::take(&mut self.reductions) {
            let start = self.program.code.len() as u32;
            self.program.code.extend(code);
            self.program.ranges.push([start, self.program.code.len() as u32]);
        }
        self.program
    }

    fn begin(&mut self) -> u32 {
        self.depth = 0;
        self.deps = Deps::default();
        self.columns_read = 0;
        self.program.code.len() as u32
    }

    fn close(&mut self, name: &str, start: u32) {
        self.program.ranges.push([start, self.program.code.len() as u32]);
        let reads = Reads { deps: self.deps, columns: self.columns_read };
        self.program.channels.push(Channel { name: name.into(), reads });
    }

    /// Compiles channel `name` storing the theme's value in `slot`, for an option left unset.
    pub(crate) fn theme(&mut self, name: &str, slot: u32, store: Store) -> Result<()> {
        let start = self.begin();
        self.op(wgsl::OP_THEME, slot, 0, 0, 0, 1)?;
        self.store_op(store)?;
        self.close(name, start);
        Ok(())
    }

    fn store(&mut self, expr: &Expr, store: Store) -> Result<()> {
        let want = match store {
            Store::Number { .. } | Store::Size { .. } => Ty::Number,
            Store::Color { .. } => Ty::Color,
            Store::Flag { .. } => Ty::Bool,
        };
        self.expect(expr, want)?;
        self.store_op(store)
    }

    fn store_op(&mut self, store: Store) -> Result<()> {
        let slot = |s: Option<u32>| s.unwrap_or(NONE);
        match store {
            Store::Number { word, fallback } => self.op(wgsl::OP_STORE, word, slot(fallback), 0, 1, 0),
            Store::Size { word, units, fallback } => {
                self.program.units |= u32::from(units) << word;
                self.op(wgsl::OP_STORE, word, slot(fallback), 0, 1, 0)
            }
            Store::Color { word, fallback } => self.op(wgsl::OP_STORE_COLOR, word, fallback, 0, 1, 0),
            Store::Flag { word, bit } => self.op(wgsl::OP_STORE_FLAG, word, bit, 0, 1, 0),
        }
    }

    /// The column of a plain number field or point component, with its low part.
    fn plain(&mut self, e: &Expr) -> Option<u32> {
        let Node::Field(f) = &*e.0 else { return None };
        if f.of.is_some() || f.step {
            return None;
        }
        let part = match (self.fields.kind(None, &f.name)?, f.component) {
            (Kind::Number, None) => Part::Values,
            (Kind::Geometry(0), Some(0)) => Part::X,
            (Kind::Geometry(0), Some(1)) => Part::Y,
            _ => return None,
        };
        Some(self.column(ColumnUse { low: true, ..ColumnUse::own(f.name.clone(), part) }))
    }

    fn coordinate(&mut self, e: &Expr) -> Result<()> {
        if mentions_pointer(e) {
            return Err(invalid("pointer() cannot place a position"));
        }
        self.expect(e, Ty::Number)
    }

    fn expect(&mut self, e: &Expr, want: Ty) -> Result<()> {
        if let Node::Missing = &*e.0 {
            let word = match want {
                Ty::Color => wgsl::MISSING_COLOR,
                Ty::Bool => 0,
                Ty::Number | Ty::Text => wgsl::MISSING,
            };
            self.constant(word, want)?;
            return Ok(());
        }
        match (self.emit(e)?, want) {
            (got, want) if got == want => Ok(()),
            (Ty::Bool, Ty::Number) => Ok(()),
            (got, want) => Err(invalid(format!("expected {}, found {}", ty_name(want), ty_name(got)))),
        }
    }

    fn emit(&mut self, e: &Expr) -> Result<Ty> {
        match &*e.0 {
            Node::Number(v) => self.constant((*v as f32).to_bits(), Ty::Number),
            Node::Bool(b) => self.constant(f32::from(u8::from(*b)).to_bits(), Ty::Bool),
            Node::Color(c) => self.constant(c.packed(), Ty::Color),
            Node::Missing => self.push(wgsl::OP_MISSING, 0, Ty::Number),
            Node::Field(f) => self.field(f),
            Node::State(State::Selected) => self.state(wgsl::OP_SELECTED, Deps::FOCUS, Ty::Bool),
            Node::State(State::Hovered) => self.state(wgsl::OP_HOVERED, Deps::FOCUS, Ty::Bool),
            Node::State(State::Pointer) => self.state(wgsl::OP_POINTER, Deps::POINTER, Ty::Number),
            Node::State(State::Elapsed) => self.state(wgsl::OP_ELAPSED, Deps::TIME, Ty::Number),
            Node::State(State::Zoom) => self.state(wgsl::OP_ZOOM, Deps::CAMERA, Ty::Number),
            Node::Unary(op, a) => {
                let ty = match (op, self.emit(a)?) {
                    (Unary::Not, Ty::Bool) => Ty::Bool,
                    (Unary::Not, t) => return Err(invalid(format!("not of {}", ty_name(t)))),
                    (_, Ty::Number | Ty::Bool) => Ty::Number,
                    (op, t) => return Err(invalid(format!("{op:?} of {}", ty_name(t)).to_lowercase())),
                };
                self.op(unary_code(*op), 0, 0, 0, 1, 1)?;
                Ok(ty)
            }
            Node::Binary(op, a, b) => self.binary(*op, a, b),
            Node::When(c, a, b) => {
                self.expect(c, Ty::Bool).map_err(|e| e.at("when"))?;
                // A missing value takes the other branch's type, so it goes last: a missing first
                // branch swaps the branches and negates the condition.
                let (a, b) = match (&*a.0, &*b.0) {
                    (Node::Missing, Node::Missing) => (a, b),
                    (Node::Missing, _) => {
                        self.op(unary_code(Unary::Not), 0, 0, 0, 1, 1)?;
                        (b, a)
                    }
                    _ => (a, b),
                };
                let ta = self.emit(a)?;
                if let Node::Missing = &*b.0 {
                    self.expect(b, ta)?;
                    self.op(wgsl::OP_SELECT, 0, 0, 0, 3, 1)?;
                    return Ok(ta);
                }
                let ty = match (ta, self.emit(b)?) {
                    (a, b) if a == b => a,
                    (Ty::Bool, Ty::Number) | (Ty::Number, Ty::Bool) => Ty::Number,
                    (a, b) => return Err(invalid(format!("when chooses between {} and {}", ty_name(a), ty_name(b)))),
                };
                self.op(wgsl::OP_SELECT, 0, 0, 0, 3, 1)?;
                Ok(ty)
            }
            Node::Is(a, text) => {
                let Node::Field(f) = &*a.0 else { return Err(invalid("is compares a text field")) };
                if self.fields.kind(f.of.as_ref(), &f.name) != Some(Kind::Text) {
                    return Err(invalid("is compares a text field").at(&f.name));
                }
                let column = self.field_column(f, Part::Codes, false);
                self.op(wgsl::OP_FIELD, column, 0, 0, 0, 1)?;
                let constant = self.program.constants.len() as u32;
                self.program.constants.push(NONE);
                self.program.texts.push(TextUse { constant, column, text: text.clone() });
                self.op(wgsl::OP_CONST, constant, 0, 0, 0, 1)?;
                self.op(wgsl::OP_EQ, 0, 0, 0, 2, 1)?;
                Ok(Ty::Bool)
            }
            Node::Scale { input, domain, range } => {
                self.expect(input, Ty::Number)?;
                let d = self.domain(input, *domain)?;
                let r = self.program.constants.len() as u32;
                self.program.constants.extend([(range[0] as f32).to_bits(), (range[1] as f32).to_bits()]);
                self.op(wgsl::OP_SCALE, d, r, 0, 1, 1)?;
                Ok(Ty::Number)
            }
            Node::Colormap { input, colormap, domain } => {
                self.expect(input, Ty::Number)?;
                let d = self.domain(input, *domain)?;
                let at = self.program.code.len() as u32;
                self.program.colormaps.push((at, colormap.clone()));
                self.op(wgsl::OP_COLORMAP, (colormap.kind() as u32) << 16, d, colormap.count(), 1, 1)?;
                Ok(Ty::Color)
            }
        }
    }

    fn field(&mut self, f: &FieldRef) -> Result<Ty> {
        let kind = self.fields.kind(f.of.as_ref(), &f.name).ok_or_else(|| match &f.of {
            Some((data, table)) => invalid(format!("no field {} in {data}.{table}", f.name)),
            None => invalid(format!("no field {}", f.name)),
        })?;
        let (part, ty, sampled) = match (kind, f.component) {
            (Kind::Number, None) => (Part::Values, Ty::Number, false),
            (Kind::Bool, None) => (Part::Values, Ty::Bool, false),
            (Kind::Text, None) => (Part::Codes, Ty::Text, false),
            (Kind::Sampled, None) => (Part::Values, Ty::Number, true),
            (Kind::Geometry(0), Some(0)) => (Part::X, Ty::Number, false),
            (Kind::Geometry(0), Some(1)) => (Part::Y, Ty::Number, false),
            (Kind::Reference, _) => return Err(invalid("a reference names rows; read it as an end").at(&f.name)),
            _ => return Err(invalid("not a number, boolean, or text field").at(&f.name)),
        };
        let column = self.field_column(f, part, sampled);
        self.deps |= if sampled { Deps::SAMPLES } else { Deps::DATA };
        self.op(wgsl::OP_FIELD, column, 0, 0, 0, 1)?;
        Ok(ty)
    }

    fn field_column(&mut self, f: &FieldRef, part: Part, sampled: bool) -> u32 {
        self.deps |= if sampled { Deps::SAMPLES } else { Deps::DATA };
        let step = f.step && sampled;
        self.column(ColumnUse { of: f.of.clone(), sampled, step, ..ColumnUse::own(f.name.clone(), part) })
    }

    fn column(&mut self, use_: ColumnUse) -> u32 {
        let columns = &mut self.program.columns;
        let i = columns.iter().position(|c| c == &use_).unwrap_or_else(|| {
            columns.push(use_);
            columns.len() - 1
        });
        self.columns_read |= Reads::column(i);
        i as u32
    }

    fn binary(&mut self, op: Binary, a: &Expr, b: &Expr) -> Result<Ty> {
        let (ta, tb) = (self.emit(a)?, self.emit(b)?);
        let numbers = matches!(ta, Ty::Number | Ty::Bool) && matches!(tb, Ty::Number | Ty::Bool);
        let bools = ta == Ty::Bool && tb == Ty::Bool;
        let ty = match op {
            Binary::Add
            | Binary::Sub
            | Binary::Mul
            | Binary::Div
            | Binary::Rem
            | Binary::Pow
            | Binary::Min
            | Binary::Max
                if numbers =>
            {
                Ty::Number
            }
            Binary::Lt | Binary::Le | Binary::Gt | Binary::Ge | Binary::Eq | Binary::Ne if numbers => Ty::Bool,
            Binary::Eq | Binary::Ne if ta == Ty::Color && tb == Ty::Color => Ty::Bool,
            Binary::And | Binary::Or if bools => Ty::Bool,
            _ => {
                let hint = if ta == Ty::Text || tb == Ty::Text { "; compare text with is" } else { "" };
                let reason = format!("{} of {} and {}{hint}", binary_name(op), ty_name(ta), ty_name(tb));
                return Err(invalid(reason));
            }
        };
        self.op(binary_code(op), 0, 0, 0, 2, 1)?;
        Ok(ty)
    }

    /// A domain record in the constants; a fitted one adds a reduction of its input.
    fn domain(&mut self, input: &Expr, domain: Domain) -> Result<u32> {
        let at = self.program.constants.len() as u32;
        match domain {
            Domain::Fixed([a, b]) => {
                self.program.constants.extend([0, (a as f32).to_bits(), (b as f32).to_bits(), 0]);
            }
            Domain::Fit => {
                if self.reducing {
                    return Err(invalid("a fitted domain's input cannot fit another domain; set one with domain"));
                }
                let index = self.program.domains.len() as u32;
                self.program.domains.push(Reads::default());
                self.program.constants.extend([1, 0, 0, index]);
                // Compile the input again as a reduction; `finish` places it after the channels.
                let saved = (std::mem::take(&mut self.program.code), self.depth, self.deps, self.columns_read);
                self.depth = 0;
                self.deps = Deps::default();
                self.columns_read = 0;
                self.reducing = true;
                let result = self.expect(input, Ty::Number).and_then(|()| self.op(wgsl::OP_REDUCE, index, 0, 0, 1, 0));
                self.reducing = false;
                let reduction = std::mem::replace(&mut self.program.code, saved.0);
                let reads = Reads { deps: self.deps, columns: self.columns_read };
                self.depth = saved.1;
                self.deps = saved.2 | Deps::DOMAIN;
                self.columns_read = saved.3 | reads.columns;
                result?;
                self.program.domains[index as usize] = reads;
                self.reductions.push(reduction);
            }
        }
        Ok(at)
    }

    fn state(&mut self, code: u32, deps: Deps, ty: Ty) -> Result<Ty> {
        self.deps |= deps;
        self.push(code, 0, ty)
    }

    fn push(&mut self, code: u32, a: u32, ty: Ty) -> Result<Ty> {
        self.op(code, a, 0, 0, 0, 1)?;
        Ok(ty)
    }

    fn constant(&mut self, word: u32, ty: Ty) -> Result<Ty> {
        let constants = &mut self.program.constants;
        let i = constants.iter().position(|&c| c == word).unwrap_or_else(|| {
            constants.push(word);
            constants.len() - 1
        });
        self.push(wgsl::OP_CONST, i as u32, ty)
    }

    fn op(&mut self, code: u32, a: u32, b: u32, c: u32, pops: u32, pushes: u32) -> Result<()> {
        self.depth = self.depth - pops + pushes;
        if self.depth > wgsl::STACK {
            return Err(invalid("expression too deep"));
        }
        self.program.code.push([code, a, b, c]);
        Ok(())
    }
}

fn mentions_pointer(e: &Expr) -> bool {
    match &*e.0 {
        Node::State(State::Pointer) => true,
        Node::Unary(_, a) | Node::Is(a, _) => mentions_pointer(a),
        Node::Binary(_, a, b) => mentions_pointer(a) || mentions_pointer(b),
        Node::When(c, a, b) => mentions_pointer(c) || mentions_pointer(a) || mentions_pointer(b),
        Node::Scale { input, .. } | Node::Colormap { input, .. } => mentions_pointer(input),
        _ => false,
    }
}

fn unary_code(op: Unary) -> u32 {
    match op {
        Unary::Neg => wgsl::OP_NEG,
        Unary::Not => wgsl::OP_NOT,
        Unary::Abs => wgsl::OP_ABS,
        Unary::Sqrt => wgsl::OP_SQRT,
        Unary::Sin => wgsl::OP_SIN,
        Unary::Cos => wgsl::OP_COS,
        Unary::Floor => wgsl::OP_FLOOR,
        Unary::Ln => wgsl::OP_LOG,
        Unary::Exp => wgsl::OP_EXP,
    }
}

fn binary_code(op: Binary) -> u32 {
    match op {
        Binary::Add => wgsl::OP_ADD,
        Binary::Sub => wgsl::OP_SUB,
        Binary::Mul => wgsl::OP_MUL,
        Binary::Div => wgsl::OP_DIV,
        Binary::Rem => wgsl::OP_MOD,
        Binary::Pow => wgsl::OP_POW,
        Binary::Min => wgsl::OP_MIN,
        Binary::Max => wgsl::OP_MAX,
        Binary::Lt => wgsl::OP_LT,
        Binary::Le => wgsl::OP_LE,
        Binary::Gt => wgsl::OP_GT,
        Binary::Ge => wgsl::OP_GE,
        Binary::Eq => wgsl::OP_EQ,
        Binary::Ne => wgsl::OP_NE,
        Binary::And => wgsl::OP_AND,
        Binary::Or => wgsl::OP_OR,
    }
}

fn binary_name(op: Binary) -> &'static str {
    match op {
        Binary::Add => "sum",
        Binary::Sub => "difference",
        Binary::Mul => "product",
        Binary::Div => "quotient",
        Binary::Rem => "remainder",
        Binary::Pow => "power",
        Binary::Min => "min",
        Binary::Max => "max",
        Binary::Lt | Binary::Le | Binary::Gt | Binary::Ge => "comparison",
        Binary::Eq | Binary::Ne => "equality",
        Binary::And => "and",
        Binary::Or => "or",
    }
}

fn ty_name(ty: Ty) -> &'static str {
    match ty {
        Ty::Number => "a number",
        Ty::Bool => "a boolean",
        Ty::Color => "a color",
        Ty::Text => "a text",
    }
}
