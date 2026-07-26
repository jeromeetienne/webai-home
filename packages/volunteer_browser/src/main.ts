const log = (value: unknown) => { document.querySelector("#log")!.textContent += `${JSON.stringify(value)}\n`; };
document.querySelector("#connect")!.addEventListener("click", () => {
  const socket = new WebSocket(`ws://${location.hostname}:8787`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", role: "volunteer", name: (document.querySelector("#name") as HTMLInputElement).value, capabilities: ["multiply", "add"] })));
  socket.addEventListener("message", (event) => { const message = JSON.parse(event.data); log(message); if (message.type !== "stage.assign") return; const value = message.stage === "multiply" ? message.value * 2 : message.value + 7; socket.send(JSON.stringify({ type: "stage.result", taskId: message.taskId, stage: message.stage, value })); });
});
