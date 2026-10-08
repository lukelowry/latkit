# Latkit connection wire format

Below, the model is the side that offers a model and the consumer is the side that accepts it;
either may dial. The dialing side offers the WebSocket subprotocol naming its role:
`latkit.connect` when it offers a model, `latkit.accept` when it accepts one. The answering side
selects it, and each side fails a socket that negotiated anything else. The URL, authentication,
routing, naming, uniqueness, sharing, storage retention, and replay are application policy.

One complete binary WebSocket message contains one frame. Text, shared memory, foreign magic,
unknown opcodes, malformed lengths, out-of-sequence publications, and credit violations fail the
connection. JSON or layout failures found when consuming a publication fail that operation.

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

Metadata follows the header. Zero padding advances the body start to an 8-byte boundary. Each
binary fragment starts at an 8-byte body offset; the last fragment needs no tail padding. Message
length must equal `align8(24 + metadataLength) + bodyLength`. Only publication and run messages
carry a body. Bounds cover the complete message, metadata, and decoder complexity, and are enforced
before allocating typed views: metadata nests at most 24 levels and holds at most 8,192 values.
Each side should cap native inbound WebSocket messages at `messageBytes`.

The frame carries no version: a frame with another magic is not a latkit frame, and a changed codec
makes older implementations obsolete.

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
| 11 progress   | model → consumer | completed, optional total/message/domain                      |
| 12 log        | model → consumer | entries: [{severity, message, optional code}], dropped        |
| 13 close      | either           | code, message                                                 |

Registration occurs once and carries no field values. Its metadata must fit the receiving side's
initial bounds. Limits are positive integers below 2^32 (`timeoutMs` below 2^31), named
`messageBytes`, `metadataBytes`, `bufferedBytes`, `bufferedMessages`, `streamWindowBytes`,
`streamWindowMessages`, `streams`, `publicationBatches`, `logs`, and `timeoutMs`. `metadataBytes`
is at least 1,024; `metadataBytes` + 1,024 ≤ `messageBytes` ≤ `streamWindowBytes` ≤
`bufferedBytes`; and `streamWindowMessages` ≤ `bufferedMessages`. The consumer responds with the
elementwise minimum of its limits and the offer; both sides enforce that agreement thereafter.

The consumer allocates strictly increasing nonzero u32 request IDs across monitors and runs. IDs
are never reused; exhaustion requires a new connection. A monitor or run grants a window of
`messageBytes` to `streamWindowBytes` bytes and 1 to `streamWindowMessages` messages. At most one
command executes: the model answers a run that arrives during another with an `error` whose code
is `busy`. Monitors have their own streams and may continue during commands. Admission never
queues an unbounded number of operations.

Each publication sequence starts at 1 and increases by 1 within its request. The sender charges
its complete encoded byte size and one message against the granted window. The sum of reserved
windows is bounded by the negotiated `bufferedBytes` and `bufferedMessages`. A cumulative ack
releases sizes through its sequence. It does not prove durable storage or command success. No more
than one publication write may be pending per stream.

An end, result, or error follows all publications for its request. It does not release data
credit. The receiver sends a terminal ack once it has consumed or discarded all preceding data.
The terminal ack can repeat the last acknowledged sequence, or use zero for an empty stream; it
releases the model's stream descriptor. Ordinary acks must strictly advance. A cancel for an
already released descriptor is ignored. Acks are cumulative state, not one receipt per
publication: a pending ack may advance to the latest consumed sequence and become terminal. The
receiver keeps its reservation until its terminal ack is sent, so later admission follows that
ack. Credit and socket-drain waits have no elapsed-time deadline.

Cancel aborts the model's work; the model still sends a terminal outcome. The consumer discards
and acknowledges in-flight publications while it waits for that outcome. If none arrives within
`timeoutMs` of sending the cancel, the consumer fails the connection. Registration, close
notification, and cleanup are also bounded by `timeoutMs`. No retry, replay, rollback, or
persistent execution identity is implied.

Progress and logs are bounded control messages, independent of data credit. Progress is the latest
pending state. A log message carries at most `logs` entries and reports lost entries as `dropped`.
Commands may finish without publishing data. The consumer's publish callbacks finish before a
command's result promise resolves. An empty field selection reads nothing.

A socket closed before registration carries its reason as the WebSocket close reason, which the
other side reports as a `disconnected` failure.

## Column payloads

A publication's metadata is `{batches: [...]}`, holding 1 to `publicationBatches` batches in the
model's RowBatch/SampleBatch shape. Native binary leaves become `{type, offset, length}`
descriptors, where length counts elements, offset counts bytes from the body start, and type is
uint8, uint32, int32, float32, or float64. All offsets are 8-byte aligned, in range, and correctly
typed. Total referenced bytes cannot exceed the body size. Numeric sample offset, rowStride, and
frameStride are preserved; arrays are never serialized as JSON number lists or transposed.
References preserve their target Index. UTF-8 text, packed validity, booleans, vectors, lists,
IDs, and sparse row indices use the same descriptors.

The encoder copies exposed typed-array views into one frame, including any addressed padding; it
does not serialize entire underlying allocations. The decoder creates views of the received frame
on little-endian systems, copies unaligned input when needed, and swaps arrays on big-endian
systems. Layout and schema validation precede delivery.

For storage, an `EncodedPublication.bytes` is the frame from byte 16 onward: two u32 lengths,
JSON, alignment padding, and body, without magic, opcode, request ID, or sequence. It is not a
whole frame; decode it with `protocol.decodePublication({bytes}, schema, bounds)`. A side serving
a received publication onward sends those bytes unchanged behind a new 16-byte header when they
fit the onward bounds.

## Arguments

File arguments are bounded attachments in a run message's body. Their metadata replaces each File
value with `{name, mediaType, lastModified, offset, bytes}`; an array of files becomes an array of
descriptors. The receiver validates bounds before constructing Files. Oversized attachments fail
before file contents are read. Other arguments and results are finite JSON matching the shared
command descriptions.
