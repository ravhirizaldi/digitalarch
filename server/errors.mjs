export function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function publicError(error) {
  return {
    code: error.statusCode ? error.code : 'scan_failed',
    message: error.statusCode
      ? error.message
      : 'The operation failed. Check the server log; saved pages are retained.',
  };
}
