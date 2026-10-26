/** Where detection found a target, in a person's words. */
export function foundBy(by: string | undefined): string {
  switch (by) {
    case "env":
      return "from its environment variables";
    case "binary":
      return "on your PATH";
    case "project":
      return "in this project";
    case "user":
      return "in your home folder";
    default:
      return "on this machine";
  }
}
