# Latkit connection wire format, version 1

WebSocket subprotocol: `latkit`. Both endpoints must select it. One complete binary WebSocket
message contains one frame. Text, shared memory, unknown versions/opcodes, malformed lengths,
out-of-sequence publications, and credit violations fail the connection. JSON/layout failures
encountered when consuming a publication fail that operation. No model payload is sent at registration.

## Frame

All integers and numeric payloads are little-endian. The 24-byte header is:

| Byte offset | Type | Meaning                                               |
| ----------- | ---- | ----------------------------------------------------- |
| 0           | u32  | Magic 0x3154414c (LAT1)                               |
| 4           | u16  | Wire version 1                                        |
| 6           | u16  | Opcode                                                |
| 8           | u32  | Request ID; registration/connection control uses zero |
| 12          | u32  | Publication sequence; all other messages use zero     |
| 16          | u32  | UTF-8 JSON metadata length                            |
| 20          | u32  | Binary body length                                    |

Metadata follows the header. Zero padding advances the body start to an 8-byte boundary.
Each binary fragment starts at an 8-byte body offset; the last fragment needs no tail padding.
Message length must equal `align8(24 + metadataLength) + bodyLength`. Bounds cover the complete
message, metadata, and decoder complexity, and are enforced before allocating typed views.

## Messages

| Opcode        | Direction       | Metadata                                                      |
| ------------- | --------------- | ------------------------------------------------------------- |
| 1 register    | producer → host | name, schema, commands, monitoring, limits                    |
| 2 registered  | host → producer | negotiated limits                                             |
| 3 monitor     | host → producer | fields, window: {bytes, messages}                             |
| 4 run         | host → producer | command, values, outputs, window: {bytes, messages}           |
| 5 publication | producer → host | batches                                                       |
| 6 end         | producer → host | {}                                                            |
| 7 result      | producer → host | value (finite JSON; missing/void handler return becomes null) |
| 8 error       | producer → host | code, message                                                 |
| 9 cancel      | host → producer | {}                                                            |
| 10 ack        | host → producer | sequence, terminal (boolean)                                  |
| 11 progress   | producer → host | completed, optional total/message                             |
| 12 log        | producer → host | entries: [{severity, message, optional code}], dropped        |
| 13 close      | either          | code, message                                                 |

Registration occurs once. Its metadata must fit the receiving endpoint's initial bounds.
Limits are positive integers; metadata is at least 1,024 bytes, and metadata + 1,024 ≤ message
≤ stream window ≤ connection budget. Per-stream message limits cannot exceed the global count.
The peer responds with the elementwise minimum of its limits and the offer; both enforce that
agreement thereafter.

The host allocates monotonically increasing nonzero u32 request IDs across monitors and runs.
IDs are never reused; exhaustion requires a new connection. There is at most one executing
command. Monitors have their own streams and may continue during commands. Admission never queues
an unbounded number of operations.

Each publication sequence starts at 1 and increases by 1 within its request. The sender charges
its complete encoded byte size and one message against the granted stream window. The sum of
reserved windows is bounded by the negotiated connection byte/count budgets. A cumulative ack
releases sizes through its sequence. It does not prove durable storage or command success.
No more than one publication write may be pending per stream.

An end/result/error follows all publications for that request. It does not implicitly release
data credit. The receiver sends a terminal ack once it has consumed or discarded all preceding
data. The terminal ack can repeat the last acknowledged sequence, or use zero for an empty stream;
it releases the producer descriptor. Ordinary acknowledgements must strictly advance. A crossing
cancel for an already released descriptor is harmless.

Cancel aborts producer work; the producer still sends a terminal outcome. The consumer discards
and acknowledges in-flight publications while waiting for that outcome. Cancellation is bounded
by a deadline. No retry, replay, rollback, or persistent execution identity is implied.

Progress and logs are bounded control messages, independent of data credits. Progress is latest
pending state; logs report loss through the dropped count. Commands may finish without publishing
data. Host callbacks finish before a command's result promise resolves.

## Column payloads

A publication's metadata is `{batches: [...]}`. Batches use the model's RowBatch/SampleBatch shape.
Native binary leaves become `{kind, offset, length}` descriptors, where length counts elements,
offset counts bytes relative to the body, and kind is u8/u32/i32/f32/f64. All offsets are 8-byte
aligned, in range, and correctly typed. Total referenced bytes cannot exceed the body size.
Numeric sample offset/rowStride/frameStride are preserved; arrays are never serialized as JSON
number lists or transposed. References preserve their target Index. UTF-8 text, packed validity,
booleans, vectors, lists, IDs, and sparse row indices use the same explicit descriptors.

The encoder copies exposed typed-array views into one frame, including any addressed padding;
it does not serialize entire underlying allocations. The decoder creates views of the received
frame on little-endian systems, copies unaligned input when needed, and swaps arrays on big-endian
systems. Layout/schema validation precedes delivery.

For storage/forwarding, `EncodedPublication.bytes` is the frame from byte 16 onward:
two u32 lengths, JSON, alignment padding, body. It excludes op/request/sequence/version.
Its interpretation is the version-1 publication codec selected by the enclosing protocol or
application storage format. A new connection can reuse those bytes without rewriting request IDs.
Consumers use `decodePublication({bytes}, schema, bounds)`; this payload is not a whole session frame.

## Arguments and transport separation

File arguments are bounded attachments to a run message. Their metadata replaces File values
with `{name, mediaType, lastModified, offset, bytes}`; arrays of files use arrays of descriptors. The receiver
validates bounds before constructing Files. Oversized attachments fail before reading file contents.
Other arguments and results are finite JSON matching shared model command descriptions.

The session state machine consumes and emits binary frames. The socket layer handles WebSocket
events and send-buffer capacity. The column codec depends on model layouts, not Lattice's registry,
UI/page wire format, rendering, or storage. Version changes happen in this package's explicit
codec, not in command names or a producer-specific Lattice subprotocol.

Authentication, routing, uniqueness, page fan-out, storage retention, and replay are host policy.
Set native inbound message caps and choose bounded fan-out behavior. There is no implicit snapshot
or global data version: model Data.version belongs to an application's immutable local value.
