declare module "picomatch" {
  export interface PicomatchOptions {
    dot?: boolean;
    nocase?: boolean;
  }

  export default function picomatch(
    pattern: string,
    options?: PicomatchOptions,
  ): (input: string) => boolean;
}
