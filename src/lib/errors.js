export function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
