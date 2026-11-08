# Browser/Node protocol vectors

`browser-crypto-v1.json` contains synthetic vectors produced by the actual UI
`wrapApiKeyAccountRoot`, `keyEnvelope`, `content`, and `media` implementations.
Its provenance records the SHA-256 of every UI source module loaded during
generation. The installation is the public P-256 **test key d=1**; every account,
record, root key, list key, filename, and payload is synthetic. Nothing is loaded
from a user profile, persistent identity, environment secret, or network.

The checked-in tests need only this repository and its normal dependencies. A
fresh clone and public CI can run `npm ci`, `npm run build`, and `npm test`
without a UI checkout. For just this coverage after building:

```sh
node --test dist/interoperability.test.js
```

The vectors verify UI-to-Node account grants and list envelopes. For the reverse
direction, Node list/field/media outputs must equal the browser's full envelope
or ciphertext SHA-256 with the recorded synthetic nonces. The optional generator
also opens Node outputs through the **actual UI MemoryContentSession**, and
opens UI outputs through Node before writing anything. No crypto operation is
mocked; nonce determinism is confined to synthetic list/field/media vectors.
API/passkey service adapters are blocked in its isolated VM, which has no fetch,
storage, process, or filesystem APIs.

Field cases cover schema v2, schema v3, default v3, empty text, Unicode text and
AAD, and compressed content spanning multiple chunks. Media covers every current
target, Unicode metadata, nested comment parents, and a multiple-chunk file.
Large payloads use the documented xorshift32 synthetic byte sequence starting at
`0x12345678`; only their ciphertext hashes are stored to keep the fixture small.
The tests replay exact nonce sequences and also verify nonzero-offset byte views,
scope substitution, truncation, and authentication failures.

To deliberately refresh against a reviewed UI checkout, build this skill first,
then supply that checkout explicitly (no external path is assumed by the code):

```sh
node test-fixtures/generate-browser-vectors.cjs <path-to-reviewed-ui-checkout>
```

Review source hashes and protocol changes before replacing vectors. Do not
regenerate fixtures merely to make a failing compatibility test pass. The
generator requires the UI source and this skill's built codec; normal tests do
not run it or require either another checkout or a browser installation.
