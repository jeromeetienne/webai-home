const status = document.querySelector("#status");
const statusBadge = document.querySelector("#status-badge");
const devices = document.querySelector("#devices");
const tasks = document.querySelector("#tasks");
const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`);

socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "register", role: "admin", name: "administrator" })));
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "registered") {
    status.textContent = "Connected to the central server.";
    statusBadge.textContent = "Connected";
    statusBadge.className = "badge rounded-pill text-bg-success";
  }
  if (message.type === "devices") devices.innerHTML = message.devices.filter((device) => device.role === "volunteer").map((device) => `<li>${device.name} (volunteer) — ${device.capabilities.join(", ")}</li>`).join("") || "<li>Waiting for volunteer browser tabs.</li>";
  if (message.type === "task.updated" || message.type === "task.accepted") tasks.textContent = JSON.stringify(message.task, null, 2);
});
socket.addEventListener("close", () => {
  status.textContent = "Disconnected from the central server.";
  statusBadge.textContent = "Disconnected";
  statusBadge.className = "badge rounded-pill text-bg-danger";
});
