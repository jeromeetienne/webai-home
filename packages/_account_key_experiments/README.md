# `@webai/account-key-experiments`

Browser experiments about account key pairs: what a real browser tab can and cannot do with a signing key pair of its own. The package is private, standalone, and not part of the root build script. It does not import from or depend on any other package in this repository.

This package exists because of the accounting system recorded in [issue #122](https://github.com/webai-at-home/webai-at-home/issues/122) and its implementation plan in [issue #123](https://github.com/webai-at-home/webai-at-home/issues/123). Version 1 of the accounting system identifies every participant by a public and private key pair, and the participant that most needs one is a volunteer browser tab. Milestone 0 of that plan is a de-risk gate that has to pass before any accounting code is written:

> A worker browser tab can generate a key pair whose private key cannot be read back out, keep that key pair across page reloads and across browser restarts, and sign a value the gateway sends it, with a signature the gateway's Node.js process can verify.

## Run

From the repository root:

```sh
npm run dev --workspace @webai/account-key-experiments -- --port 5185 --strictPort
```

Then open <http://localhost:5185/account_key_pair_log/>.

To run the gate on a phone on the same network, add `--host` to that command and open the address Vite prints, rather than `localhost`.

## Build and type check

```sh
npm run typecheck --workspace @webai/account-key-experiments
npm run build --workspace @webai/account-key-experiments
npm run preview --workspace @webai/account-key-experiments
```

## Experiments

- [`public/account_key_pair_log`](public/account_key_pair_log) — generates an account key pair with a non-extractable private key, keeps it in IndexedDB, reads it back on every later page load, checks that the browser still refuses to export the private key after storage, signs a random 32-byte challenge inside a message naming this project and this purpose, and verifies that signature in the same browser.

The page posts two things to the development server, so that a browser which cannot be scripted from this machine still leaves its result on disk instead of only in its own console:

- a **verification document** into `verification_documents/`, once per signature. This is the successful outcome, and it is what the Node.js script reads.
- a **run report** into `run_reports/`, once per page load, whether the page succeeded or failed. This is what tells a browser that could not generate or store a key pair at all apart from a browser that never opened the page.

Neither directory is kept in version control; both are raw results of a run.

## The two halves of the gate

The browser half is the page. The Node.js half is [`tools/verify_account_key_signature.js`](tools/verify_account_key_signature.js), which holds no browser code at all and stands in for the gateway:

```sh
npm run verify_account_key_signature --workspace @webai/account-key-experiments -- verification_documents/<file>.json
```

It imports the public key the browser exported, rebuilds the signed message from the challenge in the document rather than trusting the text the document claims was signed, verifies the signature, and then verifies the same signature against a deliberately altered challenge to confirm that a wrong challenge is refused. It exits non-zero when any of that fails.

The verification document carries the public key, the challenge, and the signature. It cannot carry the private key: the private key was generated as non-extractable, so the browser refuses to hand it over, which is the property the whole gate exists to establish.

## What the gate has found so far

Every run below was a real browser window on one Mac (macOS 26.2) on 2026-08-05, against the page served over `http://localhost`, which counts as a secure context.

| Browser | Algorithm chosen | Private key export | Read back after a page reload | Signature verified in Node.js |
| --- | --- | --- | --- | --- |
| Google Chrome 150 | `Ed25519` | refused | yes, same key pair | yes, `spki` and `raw` |
| Safari 26.2 | `Ed25519` | refused | yes, same key pair | yes, `spki` and `raw` |
| The in-app Chromium of Claude Code (Chrome 148, Electron 42.7.0) | `Ed25519` | refused | yes, same key pair | yes, `spki` and `raw` |

`Ed25519` was available in every browser tested, so the `ECDSA` over `P-256` fallback the page carries has not been needed. The page probes both on every load and reports both, so the day a browser refuses `Ed25519` the log says so.

Two findings that are not failures of the gate, and belong in the accounting design rather than in this package:

- `navigator.storage.persist()` returned `false` in the in-app Chromium, meaning the browser has made no promise to keep the stored key pair when it needs disk space. A browser that evicts the key pair loses the account, so account recovery is a real question for the accounting system rather than a theoretical one.
- The key pair lives in one browser profile on one device. A person contributing from a laptop and from a phone therefore holds two separate accounts unless the accounting system offers a way to link them.

### Still to run

- **A full browser restart**, in each browser: quit the browser completely, reopen it, and open the page again. The log must still say the key pair was read back from IndexedDB, with the same generation time and a higher load count. Page reloads have been proven; a process restart has not.
- **Firefox.** Opening the page in Firefox from the command line, with both `open -a Firefox <url>` and Firefox's own binary with `--new-tab`, produced no run report at all on this machine, and Firefox answers no Apple Events, so the window could not be inspected either. Firefox has to be driven by hand: open the page in it, and the run report appears in `run_reports/` on its own.
- **A phone browser**, on the same measurements, served with `--host`.
