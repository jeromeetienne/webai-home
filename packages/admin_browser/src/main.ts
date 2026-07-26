const status = document.querySelector("#status")!;
const devices = document.querySelector("#devices")!;
const tasks = document.querySelector("#tasks")!;
const socket = new WebSocket(`ws://${location.hostname}:8787`);
socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", role: "admin", name: "administrator" })));
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "registered") status.textContent = `Connected as ${message.deviceId}`;
  if (message.type === "devices") devices.innerHTML = message.devices.filter((device: { role: string }) => device.role === "volunteer").map((device: { name: string; role: string; capabilities: string[] }) => `<li>${device.name} (volunteer) — ${device.capabilities.join(", ")}</li>`).join("") || "<li>Waiting for volunteer browser tabs.</li>";
  if (message.type === "task.updated" || message.type === "task.accepted") tasks.textContent = `${JSON.stringify(message.task, null, 2)}\n${tasks.textContent}`;
});
