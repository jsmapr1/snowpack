const PUBLIC_ENV_REGEX = /^SNOWPACK_PUBLIC_/;
export function generateEnvModule(mode: 'development' | 'production') {
  const envObject = {...process.env};
  for (const env of Object.keys(envObject)) {
    if (!PUBLIC_ENV_REGEX.test(env)) {
      delete envObject[env];
    }
  }
  envObject.MODE = mode;
  envObject.NODE_ENV = mode;
  return `export default ${JSON.stringify(envObject)};`;
}
