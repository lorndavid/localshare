/**
 * Services that must never be exposed publicly by default.
 */

export interface SensitiveService {
  port: number;
  service: string;
  category: 'database' | 'cache' | 'remote-access' | 'container' | 'infrastructure' | 'messaging' | 'admin';
}

export const SENSITIVE_SERVICES: readonly SensitiveService[] = [
  { port: 22, service: 'SSH', category: 'remote-access' },
  { port: 23, service: 'Telnet', category: 'remote-access' },
  { port: 25, service: 'SMTP', category: 'infrastructure' },
  { port: 135, service: 'Windows RPC', category: 'infrastructure' },
  { port: 139, service: 'NetBIOS / SMB', category: 'infrastructure' },
  { port: 445, service: 'SMB file sharing', category: 'infrastructure' },
  { port: 1080, service: 'SOCKS proxy', category: 'infrastructure' },
  { port: 1433, service: 'Microsoft SQL Server', category: 'database' },
  { port: 1521, service: 'Oracle Database', category: 'database' },
  { port: 2375, service: 'Docker daemon (unencrypted)', category: 'container' },
  { port: 2376, service: 'Docker daemon (TLS)', category: 'container' },
  { port: 2379, service: 'etcd', category: 'infrastructure' },
  { port: 2380, service: 'etcd peer', category: 'infrastructure' },
  { port: 3128, service: 'HTTP proxy', category: 'infrastructure' },
  { port: 3306, service: 'MySQL / MariaDB', category: 'database' },
  { port: 3389, service: 'Remote Desktop (RDP)', category: 'remote-access' },
  { port: 5432, service: 'PostgreSQL', category: 'database' },
  { port: 5672, service: 'RabbitMQ (AMQP)', category: 'messaging' },
  { port: 5900, service: 'VNC', category: 'remote-access' },
  { port: 5984, service: 'CouchDB', category: 'database' },
  { port: 5985, service: 'WinRM', category: 'remote-access' },
  { port: 5986, service: 'WinRM (TLS)', category: 'remote-access' },
  { port: 6379, service: 'Redis', category: 'cache' },
  { port: 6443, service: 'Kubernetes API server', category: 'container' },
  { port: 7000, service: 'Cassandra', category: 'database' },
  { port: 8500, service: 'Consul', category: 'infrastructure' },
  { port: 9042, service: 'Cassandra CQL', category: 'database' },
  { port: 9092, service: 'Kafka', category: 'messaging' },
  { port: 9200, service: 'Elasticsearch', category: 'database' },
  { port: 9300, service: 'Elasticsearch transport', category: 'database' },
  { port: 10250, service: 'Kubernetes kubelet', category: 'container' },
  { port: 11211, service: 'Memcached', category: 'cache' },
  { port: 15672, service: 'RabbitMQ management', category: 'admin' },
  { port: 27017, service: 'MongoDB', category: 'database' },
  { port: 27018, service: 'MongoDB shard', category: 'database' },
  { port: 27019, service: 'MongoDB config server', category: 'database' },
];

const BY_PORT = new Map(SENSITIVE_SERVICES.map((s) => [s.port, s]));

export function getSensitiveService(port: number): SensitiveService | undefined {
  return BY_PORT.get(port);
}

/** Process names that indicate non-HTTP or internal services regardless of port. */
const SENSITIVE_PROCESS_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^postgres(\.exe)?$/i, 'PostgreSQL'],
  [/^mysqld(\.exe)?$/i, 'MySQL'],
  [/^mariadbd?(\.exe)?$/i, 'MariaDB'],
  [/^redis-server(\.exe)?$/i, 'Redis'],
  [/^mongod(\.exe)?$/i, 'MongoDB'],
  [/^sqlservr(\.exe)?$/i, 'SQL Server'],
  [/^sshd(\.exe)?$/i, 'SSH server'],
  [/^dockerd(\.exe)?$/i, 'Docker daemon'],
  [/^memcached(\.exe)?$/i, 'Memcached'],
  [/^svchost(\.exe)?$/i, 'Windows system service'],
  [/^lsass(\.exe)?$/i, 'Windows security subsystem'],
  [/^system$/i, 'Windows kernel'],
  [/^wininit(\.exe)?$/i, 'Windows system service'],
  [/^services(\.exe)?$/i, 'Windows service control manager'],
  [/^spoolsv(\.exe)?$/i, 'Windows print spooler'],
];

export function getSensitiveProcess(processName: string | undefined): string | undefined {
  if (!processName) return undefined;
  for (const [re, label] of SENSITIVE_PROCESS_PATTERNS) if (re.test(processName)) return label;
  return undefined;
}

/** Recognise non-HTTP protocol banners returned by a TCP service on connect. */
export function detectNonHttpBanner(banner: Uint8Array | string): string | undefined {
  const text = typeof banner === 'string' ? banner : new TextDecoder('latin1').decode(banner);
  if (text.startsWith('SSH-')) return 'SSH';
  if (/^220[ -].*(smtp|esmtp|ftp)/i.test(text)) return 'SMTP/FTP';
  if (text.startsWith('-ERR') || text.startsWith('-NOAUTH') || text.startsWith('-DENIED')) return 'Redis';
  if (text.startsWith('RFB ')) return 'VNC';
  if (typeof banner !== 'string' && banner.length > 5) {
    // MySQL/MariaDB handshake: 3-byte length, seq 0, protocol version 10.
    if (banner[3] === 0 && banner[4] === 10) return 'MySQL/MariaDB';
  }
  return undefined;
}

