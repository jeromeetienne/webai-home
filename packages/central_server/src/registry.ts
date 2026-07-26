import type { Device } from "@webai/protocol";

export class DeviceRegistry {
  private readonly devices = new Map<string, Device>();

  add(device: Device): void { this.devices.set(device.id, device); }
  remove(id: string): void { this.devices.delete(id); }
  get(id: string): Device | undefined { return this.devices.get(id); }
  list(): Device[] { return [...this.devices.values()]; }
  findVolunteer(stage: "multiply" | "add", excluded: string[] = []): Device | undefined {
    return this.list().find((device) => device.role === "volunteer" && device.capabilities.includes(stage) && !excluded.includes(device.id));
  }
}
