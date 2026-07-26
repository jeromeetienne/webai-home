import type { Device } from "@webai/protocol";

export class DeviceRegistry {
  private readonly devices = new Map<string, Device>();

  add(device: Device): void { this.devices.set(device.deviceId, device); }
  remove(deviceId: string): void { this.devices.delete(deviceId); }
  get(deviceId: string): Device | undefined { return this.devices.get(deviceId); }
  list(): Device[] { return [...this.devices.values()]; }
  findByName(name: string, role: Device["role"]): Device | undefined {
    return this.list().find((device) => device.name === name && device.role === role);
  }
  findVolunteer(stage: "multiply" | "add", excluded: string[] = []): Device | undefined {
    return this.list().find((device) => device.role === "volunteer" && device.capabilities.includes(stage) && !excluded.includes(device.deviceId));
  }
}
