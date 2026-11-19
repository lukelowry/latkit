//! Room ahead in memory. The allocator grows the WebAssembly memory by just what each allocation
//! needs, and once the memory holds hundreds of megabytes, each growth holds the page for
//! milliseconds, so allocations in a row, as a recording opening a page for each of its row
//! blocks, held it for hundreds. Making room first, with one allocation freed at once, grows the
//! memory once: the allocator keeps that room for the allocations after it.

/// Makes room for `bytes` with one allocation, freed at once.
pub(crate) fn make_room(bytes: usize) {
    drop(std::hint::black_box(Vec::<u8>::with_capacity(bytes)));
}

/// The memory size from which [`keep_room`] makes room ahead. Below it, a growth costs little.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
const AHEAD: usize = 64 << 20;

#[cfg(all(feature = "web", target_arch = "wasm32"))]
thread_local! {
    /// The memory's size at the last [`keep_room`].
    static SEEN: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Once the WebAssembly memory has grown since the last call, makes room for an eighth more of it,
/// so the allocations after it rarely grow it. Frames and data changes call it when they end.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub fn keep_room() {
    let size = || core::arch::wasm32::memory_size::<0>() << 16;
    let memory = size();
    if SEEN.replace(memory) < memory && memory >= AHEAD {
        make_room(memory / 8);
        SEEN.set(size());
    }
}
