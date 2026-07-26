const log = (value) => {
  const output = document.querySelector("#log");
  output.textContent += `${output.textContent === "No messages yet." ? "" : "\n"}${JSON.stringify(value, null, 2)}`;
};
const status = document.querySelector("#status");
const nameInput = document.querySelector("#name");
nameInput.value = `browser-volunteer-${crypto.randomUUID().slice(0, 8)}`;

document.querySelector("#connect").addEventListener("click", () => {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);
  status.textContent = "Connecting";
  status.className = "badge text-bg-warning";
  socket.addEventListener("open", () => {
    status.textContent = "Connected";
    status.className = "badge text-bg-success";
    socket.send(JSON.stringify({ type: "register", role: "volunteer", name: nameInput.value, capabilities: ["multiply", "add"] }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    log(message);
    if (message.type !== "stage.assign") return;
    const value = message.stage === "multiply" ? message.value * 2 : message.value + 7;
    socket.send(JSON.stringify({ type: "stage.result", taskId: message.taskId, stage: message.stage, value }));
  });
  socket.addEventListener("close", () => { status.textContent = "Disconnected"; status.className = "badge text-bg-danger"; });
});
