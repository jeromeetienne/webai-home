# Worker browser

Build and serve the worker browser independently from the central gateway:

```sh
npm run build
npm start
```

During development, use `npm run dev`. The page connects to the central gateway at
`http://localhost:8787` by default. Use `?gatewayUrl=http://host:port` to connect to a
different central gateway.
