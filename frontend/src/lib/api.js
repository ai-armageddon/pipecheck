// Single place the backend location is defined. Override with REACT_APP_API_URL
// (docker-compose sets it) so the port is not duplicated across the app.
export const API_URL = (
  process.env.REACT_APP_API_URL || 'http://localhost:8001'
).replace(/\/$/, '');

export const WS_URL = API_URL.replace(/^http/, 'ws');

export const apiUrl = (path) => `${API_URL}${path}`;

export const wsUrl = (path) => `${WS_URL}${path}`;
