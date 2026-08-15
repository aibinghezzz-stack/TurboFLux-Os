import { notarize } from '@electron/notarize'

export default async function notarizeDesktop(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appleId = process.env.APPLE_ID?.trim()
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = process.env.APPLE_TEAM_ID?.trim()
  if (!appleId || !appleIdPassword || !teamId) {
    if (process.env.TURBOFLUX_REQUIRE_NOTARIZATION === '1') throw new Error('APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are required')
    return
  }
  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId,
    appleIdPassword,
    teamId,
  })
}
