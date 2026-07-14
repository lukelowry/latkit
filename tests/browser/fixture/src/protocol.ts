export type WebGpuFeatureLevel = 'core' | 'compatibility';

export type RenderProbeStatus = 'not-run' | 'passed' | 'failed';

export interface AdapterEvidence {
  readonly requestedFeatureLevel: WebGpuFeatureLevel;
  readonly effectiveFeatureLevel: WebGpuFeatureLevel | null;
  readonly adapterAvailable: boolean;
  readonly deviceAvailable: boolean;
  readonly fallback: boolean | null;
  readonly info: Readonly<Record<string, string>>;
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly renderProbe: RenderProbeStatus;
  readonly error: string | null;
}

export interface BrowserReport {
  readonly userAgent: string;
  readonly platform: string;
  readonly webgpu: {
    readonly apiAvailable: boolean;
    readonly core: AdapterEvidence;
    readonly compatibility: AdapterEvidence;
  };
}

export interface BorrowerLosses {
  readonly network: number;
  readonly monitor0: number;
  readonly monitor1: number;
}

export interface FixtureState {
  readonly generation: number;
  readonly liveMonitors: number;
  readonly ownerLosses: number;
  readonly borrowerLosses: BorrowerLosses;
  readonly uncapturedErrors: number;
  readonly lastUncapturedError: string | null;
  readonly lastOwnerLoss: Readonly<{ reason: string; message: string }> | null;
}

export interface FixtureApi {
  readonly capabilitiesReady: Promise<void>;
  readonly ready: Promise<void>;
  destroyFirstMonitor(): Promise<void>;
  remountAfterLoss(): Promise<void>;
  setProjection(mode: 'flat' | 'tilt' | 'globe'): Promise<boolean>;
  report(): BrowserReport;
  state(): FixtureState;
}
