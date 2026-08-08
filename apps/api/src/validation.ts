import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sendError } from './errors.js'

function validationFields(error: z.core.$ZodError): Record<string, string[]> {
  return z.flattenError(error).fieldErrors as Record<string, string[]>
}

/** JSON body validation that answers with the spec's 400 envelope. */
export function jsonValidator<S extends z.ZodType>(schema: S) {
  return zValidator('json', schema, (result, c) => {
    if (!result.success) {
      return sendError(c, 400, 'validation_error', 'Invalid input', validationFields(result.error))
    }
    return undefined
  })
}

/** Query-string validation that answers with the spec's 400 envelope. */
export function queryValidator<S extends z.ZodType>(schema: S) {
  return zValidator('query', schema, (result, c) => {
    if (!result.success) {
      return sendError(c, 400, 'validation_error', 'Invalid query', validationFields(result.error))
    }
    return undefined
  })
}
