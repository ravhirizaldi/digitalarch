import { useCallback, useEffect, useRef, useState } from 'react';

export function queryChoice(params, key, choices, fallback = choices[0]) {
  const value = params.get(key);
  return choices.includes(value) ? value : fallback;
}

export function queryPage(params, key) {
  const value = Number(params.get(key));
  return Number.isSafeInteger(value) && value > 0 && value <= 40001 ? value : 1;
}

export function queryZoom(params) {
  const value = params.get('zoom');
  if (value === 'page') return value;
  const zoom = Number(value);
  return Number.isFinite(zoom) && zoom >= 0.02 && zoom <= 8 ? zoom : 'width';
}

export function useUrlState(read) {
  const pathname = useRef(window.location.pathname).current;
  const [state, setState] = useState(() => read(new URLSearchParams(window.location.search)));
  useEffect(() => {
    const restore = () => {
      if (window.location.pathname === pathname)
        setState(read(new URLSearchParams(window.location.search)));
    };
    window.addEventListener('digitalarch:url-state', restore);
    return () => window.removeEventListener('digitalarch:url-state', restore);
  }, [read, pathname]);
  const update = useCallback(
    (patch, { replace = false } = {}) => {
      if (window.location.pathname !== pathname) return;
      const url = new URL(window.location.href);
      const values = { ...read(url.searchParams), ...patch };
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === '') url.searchParams.delete(key);
        else
          url.searchParams.set(
            key,
            typeof value === 'boolean' ? (value ? '1' : '0') : String(value),
          );
      }
      if (url.href === window.location.href) return;
      window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
      window.dispatchEvent(new Event('digitalarch:url-state'));
    },
    [read, pathname],
  );
  return [state, update];
}
