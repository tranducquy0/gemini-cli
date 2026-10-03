/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../config/config.js';
import {
  initializeTelemetry,
  shutdownTelemetry,
  bufferTelemetryEvent,
} from './sdk.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { JWTInput } from 'google-auth-library';
import { TelemetryTarget } from './index.js';

import * as os from 'node:os';
import * as path from 'node:path';

import { debugLogger } from '../utils/debugLogger.js';

vi.mock('@opentelemetry/exporter-trace-otlp-grpc');
vi.mock('@opentelemetry/exporter-logs-otlp-grpc');
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc');
vi.mock('@opentelemetry/exporter-trace-otlp-http');
vi.mock('@opentelemetry/exporter-logs-otlp-http');
vi.mock('@opentelemetry/exporter-metrics-otlp-http');
vi.mock('@opentelemetry/sdk-trace-node');
vi.mock('@opentelemetry/sdk-node');
vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Telemetry SDK', () => {
  let mockConfig: Config;
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getTelemetryEnabled: () => true,
      getTelemetryOtlpEndpoint: () => 'http://localhost:4317',
      getTelemetryOtlpProtocol: () => 'grpc',
      getTelemetryTarget: () => 'local',
      getTelemetryUseCollector: () => false,
      getTelemetryOutfile: () => undefined,
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getTelemetryUseCliAuth: () => false,
      isInteractive: () => false,
      getExperiments: () => undefined,
      getExperimentsAsync: async () => undefined,
      getContentGeneratorConfig: () => undefined,
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry(mockConfig);
  });

  it('should use gRPC exporters when protocol is grpc', async () => {
    await initializeTelemetry(mockConfig);

    expect(OTLPTraceExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(OTLPLogExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(OTLPMetricExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4317',
      compression: 'gzip',
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
  });

  it('should use HTTP exporters when protocol is http', async () => {
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'http://localhost:4318',
    );

    await initializeTelemetry(mockConfig);

    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/traces',
    });
    expect(OTLPLogExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/logs',
    });
    expect(OTLPMetricExporterHttp).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/metrics',
    });
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
  });

  it('should parse gRPC endpoint correctly', async () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'https://my-collector.com',
    );
    await initializeTelemetry(mockConfig);
    expect(OTLPTraceExporter).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com' }),
    );
  });

  it('should parse HTTP endpoint correctly', async () => {
    vi.spyOn(mockConfig, 'getTelemetryOtlpProtocol').mockReturnValue('http');
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue(
      'https://my-collector.com',
    );
    await initializeTelemetry(mockConfig);
    expect(OTLPTraceExporterHttp).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://my-collector.com/v1/traces' }),
    );
  });

  it('should not use OTLP exporters when telemetryOutfile is set', async () => {
    vi.spyOn(mockConfig, 'getTelemetryOutfile').mockReturnValue(
      path.join(os.tmpdir(), 'test.log'),
    );
    await initializeTelemetry(mockConfig);

    expect(OTLPTraceExporter).not.toHaveBeenCalled();
    expect(OTLPLogExporter).not.toHaveBeenCalled();
    expect(OTLPMetricExporter).not.toHaveBeenCalled();
    expect(OTLPTraceExporterHttp).not.toHaveBeenCalled();
    expect(OTLPLogExporterHttp).not.toHaveBeenCalled();
    expect(OTLPMetricExporterHttp).not.toHaveBeenCalled();
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
  });

  it('should defer initialization when useCliAuth is true and no credentials are provided', async () => {
    vi.spyOn(mockConfig, 'getTelemetryUseCliAuth').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryTarget').mockReturnValue(
      TelemetryTarget.LOCAL,
    );
    vi.spyOn(mockConfig, 'getTelemetryOtlpEndpoint').mockReturnValue('');

    // 1. Initial state: No credentials.
    // Should NOT initialize any exporters.
    await initializeTelemetry(mockConfig);

    // Verify nothing was initialized
    expect(ConsoleSpanExporter).not.toHaveBeenCalled();

    // Verify deferral log
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('deferring telemetry initialization'),
    );
  });

  describe('bufferTelemetryEvent', () => {
    it('should execute immediately if SDK is initialized', async () => {
      await initializeTelemetry(mockConfig);
      const callback = vi.fn();
      bufferTelemetryEvent(callback);
      expect(callback).toHaveBeenCalled();
    });

    it('should buffer if SDK is not initialized, and flush on initialization', async () => {
      const callback = vi.fn();
      bufferTelemetryEvent(callback);
      expect(callback).not.toHaveBeenCalled();

      await initializeTelemetry(mockConfig);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(callback).toHaveBeenCalled();
    });
  });

  it('should disable telemetry and log error if useCollector and useCliAuth are both true', async () => {
    vi.spyOn(mockConfig, 'getTelemetryUseCollector').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryUseCliAuth').mockReturnValue(true);

    await initializeTelemetry(mockConfig);

    expect(debugLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Telemetry configuration error: "useCollector" and "useCliAuth" cannot both be true',
      ),
    );
    expect(NodeSDK.prototype.start).not.toHaveBeenCalled();
  });
  it('should log error when re-initializing with different credentials', async () => {
    const creds1 = { client_email: 'user1@example.com' };
    const creds2 = { client_email: 'user2@example.com' };

    // 1. Initialize with first account
    await initializeTelemetry(mockConfig, creds1 as JWTInput);

    // 2. Attempt to initialize with second account
    await initializeTelemetry(mockConfig, creds2 as JWTInput);

    // 3. Verify error log
    expect(debugLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Telemetry credentials have changed (from user1@example.com to user2@example.com)',
      ),
    );
  });

  it('should NOT log error when re-initializing with SAME credentials', async () => {
    const creds1 = { client_email: 'user1@example.com' };

    // 1. Initialize with first account
    await initializeTelemetry(mockConfig, creds1 as JWTInput);

    // 2. Attempt to initialize with same account
    await initializeTelemetry(mockConfig, creds1 as JWTInput);

    // 3. Verify NO error log
    expect(debugLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Telemetry credentials have changed'),
    );
  });
});
