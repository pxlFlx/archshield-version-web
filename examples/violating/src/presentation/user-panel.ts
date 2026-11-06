import { readUser } from "../infrastructure/user-store.js";

export function renderUserPanel(id: string): string {
  const user = readUser(id);
  return `<span>${user.email}</span>`;
}
