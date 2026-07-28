# Volunteer browser

Build and serve the volunteer browser independently from the central server:

```sh
npm run build
npm start
```

During development, use `npm run dev`. The page connects to the central server at
`http://localhost:8787` by default. Use `?serverUrl=http://host:port` to connect to a
different central server.
