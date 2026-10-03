# Latkit connection wire format

One endpoint offers a model and the other accepts it; either may dial. The dialing side offers the
WebSocket subprotocol naming its role: `latkit.connect` when it offers a model, `latkit.accept`
when it accepts one. The answering side selects it, and each endpoint fails a socket that
negotiated anything else. The URL is the application's. One complete binary WebSocket message
contains one frame. Text, shared memory, foreign magic, unknown opcodes, malformed lengths,
out-of-sequence publications, and credit violations fail the connection. JSON/layout failures
encountered when consuming a publication fail that operation. No model payload is sent at registration.

## Frame

All integers and numeric payloads are little-endian. The 24-byte header is:

| Byte offset | Type | Meaning                                               |
| ----------- | ---- | ----------------------------------------------------- |
| 0           | u32  | Magic 0x4b54414c (LATK)                               |
| 4           | u32  | Opcode                                                |
| 8           | u32  | Request ID; registration/connection control uses zero |
| 12          | u32  | Publication sequence; all other messages use zero     |
| 16          | u32  | UTF-8 JSON metadata length                            |
| 20          | u32  | Binary body length                                    |

Metadata follows the header. Zero padding advances the body start to an 8-byte boundary.
Each binary fragment starts at an 8-byte body offset; the last fragment needs no tail padding.
Message length must equal `align8(24 + metadataLength) + bodyLength`. Bounds cover the complete
message, metadata, and decoder complexity, and are enforced before allocating typed views.

## Messages

| Opcode        | Direction        | Metadata                                                      |
| ------------- | ---------------- | ------------------------------------------------------------- |
| 1 register    | model → consumer | name, schema, commands, monitoring, limits                    |
| 2 registered  | consumer → model | negotiated limits                                             |
| 3 monitor     | consumer → model | fields, window: {bytes, messages}                             |
| 4 run         | consumer → model | command, values, outputs, window: {bytes, messages}           |
| 5 publication | model → consumer | batches                                                       |
| 6 end         | model → consumer | {}                                                            |
| 7 result      | model → consumer | value (finite JSON; missing/void handler return becomes null) |
| 8 error       | model → consumer | code, message                                                 |
| 9 cancel      | consumer → model | {}                                                            |
| 10 ack        | consumer → model | sequence, terminal (boolean)                                  |
| 11 progress   | model → consumer | completed, optional total/message                             |
| 12 log        | model → consumer | entries: [{severity, message, optional code}], dropped        |
| 13 close      | either           | code, message                                                 |

Below, the model is the endpoint that offers it and the consumer the endpoint that accepts it.
Registration occurs once. Its metadata must fit the receiving endpoint's initial bounds.
Limits are positive integers; metadata is at least 1,024 bytes, and metadata + 1,024 ≤ message
≤ stream window ≤ connection budget. Per-stream message limits cannot exceed the global count.
The peer responds with the elementwise minimum of its limits and the offer; both enforce that
agreement thereafter.

The consumer allocates monotonically increasing nonzero u32 request IDs across monitors and runs.
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
it releases the model's stream descriptor. Ordinary acknowledgements must strictly advance. A crossing
cancel for an already released descriptor is harmless. ACKs are cumulative state, not one receipt
per publication: a pending ACK may advance to the latest consumed sequence and become terminal.
The receiver retains its reservation until its terminal ACK is sent, ordering subsequent admission
after that ACK. Credit and socket-drain waits have no elapsed-time deadline.

Cancel aborts the model's work; the model still sends a terminal outcome. The consumer discards
and acknowledges in-flight publications while waiting for that outcome. Cancellation is bounded
by a response deadline starting after the cancel is sent. Registration, close notification and
application cleanup also have lifecycle deadlines. No retry, replay, rollback, or persistent
execution identity is implied.

Progress and logs are bounded control messages, independent of data credits. Progress is latest
pending state; logs report loss through the dropped count. Commands may finish without publishing
data. The consumer's publish callbacks finish before a command's result promise resolves. An empty
field selection reads nothing.

A socket closed before registration carries its reason as the WebSocket close reason, which the
other endpoint reports as a `disconnected` failure.

## Column payloads

A publication's metadata is `{batches: [...]}`. Batches use the model's RowBatch/SampleBatch shape.
Native binary leaves become `{type, offset, length}` descriptors, where length counts elements,
offset counts bytes relative to the body, and type is uint8, uint32, int32, float32, or float64. All offsets are 8-byte
aligned, in range, and correctly typed. Total referenced bytes cannot exceed the body size.
Numeric sample offset/rowStride/frameStride are preserved; arrays are never serialized as JSON
number lists or transposed. References preserve their target Index. UTF-8 text, packed validity,
booleans, vectors, lists, IDs, and sparse row indices use the same explicit descriptors.

The encoder copies exposed typed-array views into one frame, including any addressed padding;
it does not serialize entire underlying allocations. The decoder creates views of the received
frame on little-endian systems, copies unaligned input when needed, and swaps arrays on big-endian
systems. Layout/schema validation precedes delivery.

For storage, an `EncodedPublication.bytes` is the frame from byte 16 onward: two u32 lengths, JSON,
alignment padding, body. It excludes magic/op/request/sequence. Consumers use
`protocol.decodePublication({bytes}, schema, bounds)`; this payload is not a whole session frame.
An endpoint serving a received publication onward sends those bytes behind a new 16-byte header
when they fit the onward bounds, without rewriting them.

## Arguments and transport separation

File arguments are bounded attachments to a run message. Their metadata replaces File values
with `{name, mediaType, lastModified, offset, bytes}`; arrays of files use arrays of descriptors. The receiver
validates bounds before constructing Files. Oversized attachments fail before reading file contents.
Other arguments and results are finite JSON matching shared model command descriptions.

The session state machine consumes and emits binary frames. The socket layer handles WebSocket
events and send-buffer capacity. The column codec depends on model layouts, not on any
application's registry, addresses, rendering, or storage. The frame carries no version: a frame with another
magic is not a latkit frame, and a changed codec makes older endpoints obsolete.

Authentication, addresses, routing, naming, uniqueness, sharing, storage retention, and replay are
application policy. Set native inbound message caps. There is no implicit snapshot
or data version: each Data an application builds is a new immutable value.
