export type Callback<T> = (error: Error | null, value: T) => void;

export type FConvertPromise<F extends (...args: any) => any> = F extends (...args: infer A) => infer R
  ? ((...args: A) => Promise<R>) | ((...args: A) => R)
  : never;

export interface ApplicationDataUnit {
  transaction?: number;
  unit: number;
  fc: number;
  data: number[];
}

export interface ServerId {
  serverId?: number;
  runIndicatorStatus?: boolean;
  additionalData?: number[];
}

export interface DeviceIdentification {
  readDeviceIDCode: number;
  conformityLevel: number;
  moreFollows: boolean;
  nextObjectId: number;
  objects: { id: number; value: string }[];
}
