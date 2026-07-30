# flow_viewer

`flow_viewer` loads recorded gateway message logs and displays the message flow
between consumers, the gateway, and worker browsers.

## Run

```sh
npm run flow_viewer --workspace @webai/flow-viewer
```

The command scans `packages/gateway/logs` for gateway log files, serves the
flow_viewer page, and opens the page in a browser. Use `--no-open` to keep the
browser closed, or pass one or more `.log_entry.jsonl` files explicitly.

The former `cli` script remains available as a compatibility alias.
