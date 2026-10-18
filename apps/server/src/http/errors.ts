import type { FastifyError, FastifyInstance } from "fastify";

/**
 * For route groups whose services throw plain `Error`s for caller mistakes ("No such agent",
 * "Only an owner can..."): answer those with 400 and the message. Database and driver errors
 * (they carry a `code`) and anything with its own status stay as they are.
 */
export function userErrorsAre400(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: "bad_request", message: err.message });
    if (err.statusCode && err.statusCode < 500)
      return reply.code(err.statusCode).send({ error: err.code ?? "error", message: err.message });
    // Plain errors from our services carry no code; database and driver errors do.
    const plain = (err as { code?: unknown }).code === undefined && !err.statusCode;
    if (plain) {
      req.log.info({ err: err.message }, "refused a request");
      return reply.code(400).send({ error: "bad_request", message: err.message });
    }
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal", message: "Something went wrong." });
  });
}
