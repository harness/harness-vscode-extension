// HTTP(S) proxy support for all outbound fetch() calls.
//
// Node's built-in fetch (backed by undici) does not honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY
// the way tools like curl or git do — it needs an explicit dispatcher. This module wires
// one global dispatcher for the whole extension host so every existing fetch() call site
// picks up proxy support with no per-call changes.
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as tls from 'node:tls';
import type { Dispatcher, EnvHttpProxyAgent, ProxyAgent } from 'undici';
import { logger } from './logger';

let cachedCaCertificates: string[] | undefined;
let originalDispatcher: Dispatcher | undefined;
let installedDispatcher: Dispatcher | undefined;

// Loaded lazily: importing undici installs its own global dispatcher if none exists yet.
function loadUndici(): typeof import('undici') {
  return require('undici');
}

/** Strip embedded basic-auth credentials before a proxy URL ever hits the logs. */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return '<unparseable proxy URL>';
  }
}

/** Return `url` only if it is an absolute http:// or https:// URL; otherwise warn and return undefined. */
export function getValidatedProxyUrl(url: string, source = 'proxy URL'): string | undefined {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'http:' || protocol === 'https:') {
      return url;
    }
  } catch {
    // Unparseable; fall through to the warning.
  }
  // The raw value isn't echoed: without a scheme, credentials don't parse out and redactProxyUrl can't strip them.
  logger.warn('Proxy', `Ignoring ${source}: expected an http:// or https:// URL`);
  return undefined;
}

function getConfiguredProxyUrl(): string {
  return vscode.workspace.getConfiguration('harness').get<string>('proxy', '').trim();
}

function getCaBundlePath(): string {
  return vscode.workspace.getConfiguration('harness').get<string>('caBundle', '').trim();
}

/** Env proxies per scheme, in the same precedence as undici's EnvHttpProxyAgent (lowercase first). */
function getValidatedEnvProxyUrls(): { http?: string; https?: string } {
  const http = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const https = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  return {
    http: http ? getValidatedProxyUrl(http, 'http_proxy/HTTP_PROXY') : undefined,
    https: https ? getValidatedProxyUrl(https, 'https_proxy/HTTPS_PROXY') : undefined,
  };
}

/** Resolve the effective HTTPS proxy URL: `harness.proxy` setting, else https_proxy/HTTPS_PROXY, else http_proxy/HTTP_PROXY. */
export function resolveProxyUrl(): string | undefined {
  const configured = getConfiguredProxyUrl();
  const configuredUrl = configured ? getValidatedProxyUrl(configured, 'harness.proxy') : undefined;
  if (configuredUrl) {
    return configuredUrl;
  }
  const env = getValidatedEnvProxyUrls();
  return env.https || env.http;
}

function readExtraCaCertificates(): string[] {
  const extraCaPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!extraCaPath) {
    return [];
  }
  try {
    return [fs.readFileSync(extraCaPath, 'utf8')];
  } catch {
    return [];
  }
}

/** Build a trust set from Node's default CAs (incl. NODE_EXTRA_CA_CERTS), OS trust store, and an optional PEM bundle. */
export function resolveTrustedCaCertificates(): string[] {
  if (cachedCaCertificates) {
    return cachedCaCertificates;
  }

  const getCaCertificates = (tls as typeof tls & {
    getCACertificates?: (type: 'default' | 'system') => string[];
  }).getCACertificates;

  // An explicit `ca` replaces Node's defaults, so start from them rather than the bundled roots alone.
  const certificates = getCaCertificates
    ? [...getCaCertificates('default')]
    : [...tls.rootCertificates, ...readExtraCaCertificates()];

  if (getCaCertificates) {
    certificates.push(...getCaCertificates('system'));
  }

  const caBundlePath = getCaBundlePath();
  if (caBundlePath) {
    try {
      certificates.push(fs.readFileSync(caBundlePath, 'utf8'));
    } catch (err) {
      logger.warn('Proxy', `Unable to read configured CA bundle: ${(err as Error).message}`);
    }
  }

  cachedCaCertificates = [...new Set(certificates)];
  return cachedCaCertificates;
}

/**
 * Wire the global undici dispatcher based on the `harness.proxy` setting, falling back to
 * the standard HTTPS_PROXY/HTTP_PROXY/NO_PROXY environment variables when unset.
 */
export function configureProxy(): void {
  cachedCaCertificates = undefined;
  const configured = getConfiguredProxyUrl();
  const proxyUrl = configured ? getValidatedProxyUrl(configured, 'harness.proxy') : undefined;
  const envProxy = proxyUrl ? {} : getValidatedEnvProxyUrls();

  if (!proxyUrl && !envProxy.http && !envProxy.https && !getCaBundlePath()) {
    // Nothing to do: leave fetch() on its default dispatcher (keeps NODE_EXTRA_CA_CERTS and VS Code proxy handling intact).
    if (installedDispatcher && originalDispatcher) {
      swapGlobalDispatcher(originalDispatcher);
    }
    return;
  }

  const { EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher } = loadUndici();
  originalDispatcher ??= getGlobalDispatcher();
  const ca = resolveTrustedCaCertificates();

  if (proxyUrl) {
    try {
      swapGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, proxyTls: { ca }, requestTls: { ca } }));
      logger.info('Proxy', `Routing requests through configured proxy: ${redactProxyUrl(proxyUrl)}`);
      return;
    } catch (err) {
      logger.error('Proxy', `Unable to use harness.proxy: ${(err as Error).message}`);
      return;
    }
  }

  // EnvHttpProxyAgent applies NO_PROXY itself; proxies are passed explicitly so invalid env values are skipped.
  // It forwards its options to the inner ProxyAgent, so proxyTls/requestTls apply even though they're untyped here.
  const envAgentOptions: EnvHttpProxyAgent.Options & Pick<ProxyAgent.Options, 'proxyTls' | 'requestTls'> = {
    httpProxy: envProxy.http ?? '',
    httpsProxy: envProxy.https ?? '',
    connect: { ca },
    proxyTls: { ca },
    requestTls: { ca },
  };
  try {
    swapGlobalDispatcher(new EnvHttpProxyAgent(envAgentOptions));
  } catch (err) {
    logger.error('Proxy', `Invalid proxy environment variables, using direct connections: ${(err as Error).message}`);
    return;
  }
  const envProxyUrl = envProxy.https || envProxy.http;
  if (envProxyUrl) {
    logger.info('Proxy', `Routing requests through proxy from environment: ${redactProxyUrl(envProxyUrl)}`);
  }
}

function swapGlobalDispatcher(next: Dispatcher): void {
  const previous = installedDispatcher;
  loadUndici().setGlobalDispatcher(next);
  installedDispatcher = next === originalDispatcher ? undefined : next;
  // Only ever close dispatchers this module created, never the original.
  previous?.close().catch(() => undefined);
}

/** Re-apply proxy config whenever `harness.proxy` or `harness.caBundle` changes. */
export function registerProxyConfigWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('harness.proxy') || event.affectsConfiguration('harness.caBundle')) {
        configureProxy();
      }
    })
  );
}
