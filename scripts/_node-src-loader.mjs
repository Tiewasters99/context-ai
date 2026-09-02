// Probe support: let plain node import src/ modules that use the vite '@/'
// alias and extensionless TS imports. Use with:  node --import <this> probe
// Untracked by convention — scripts/_* are probes, not code.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  new URL(
    `data:text/javascript,${encodeURIComponent(`
      const SRC = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) specifier = SRC + specifier.slice(2);
        try {
          return await next(specifier, context);
        } catch (e) {
          if (e?.code === 'ERR_MODULE_NOT_FOUND' && !/\\.[a-z]+$/.test(specifier)) {
            return next(specifier + '.ts', context);
          }
          throw e;
        }
      }
    `)}`,
  ).href,
  pathToFileURL('./'),
);
