let csrfToken = '';
export const setCsrfToken = (value) => {
  csrfToken = value || '';
};

export async function api(url, body, method = 'POST') {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Scan-Request': '1',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (response.status === 401 && !url.endsWith('/login') && !url.endsWith('/me'))
    window.dispatchEvent(new Event('auth-expired'));
  if (!response.ok)
    throw Object.assign(new Error(result.error || 'The request failed.'), {
      code: result.code,
      status: response.status,
      issues: result.issues,
    });
  return result;
}
