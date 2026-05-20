export interface ProxyForwardingHeaders {
  'x-forwarded-for': string;
  'x-forwarded-host': string;
  'x-forwarded-proto': string;
  'x-real-ip': string;
  [key: string]: string;
}
