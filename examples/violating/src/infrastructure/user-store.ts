export function readUser(id: string): { id: string; email: string } {
  return { id, email: `${id}@example.test` };
}
