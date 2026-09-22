// Real-daemon check for the tools/call path chat turns use: one CuaSession,
// one read-only call, clean close. Run: bun scripts/cua-call-check.ts
import { CuaSession } from '@backend/integrations/cua';

const session = new CuaSession();
try {
  const result = await session.call('list_apps', {});
  console.log(JSON.stringify({ isError: result.isError, length: result.text.length, head: result.text.slice(0, 200) }, null, 2));
  process.exitCode = result.isError || !result.text ? 1 : 0;
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  session.close();
}
