/** An error the Fastify error handler turns into a response with this status code. */
export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
