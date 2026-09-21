import { useEffect, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import {
  POLL_INTERVAL_MS,
  checkForNewerBuild,
  currentUpdateNotice,
  subscribeUpdateNotice,
  type UpdateNotice,
} from '@/lib/app-version'

/** What the shell should be saying about this tab's build, if anything. */
export function useUpdateNotice(): UpdateNotice | null {
  return useSyncExternalStore(subscribeUpdateNotice, currentUpdateNotice, () => null)
}

/**
 * Ask the server which build it is serving, at the four moments worth asking.
 *
 *   focus / visibilitychange   coming back to a tab left open over lunch is
 *                              when a deploy is most likely to have happened
 *   route change               cheap and free-riding on work already done
 *   every five minutes         for the tab that is watched but not clicked
 *
 * All four go through one throttle (CHECK_THROTTLE_MS), so the busiest hour of
 * clicking costs one request a minute, and none of them fires while the tab is
 * hidden. Mounted once per shell by RefusalBanner — the one component every
 * signed-in layout already has.
 */
export function useVersionWatch(): void {
  const { pathname } = useLocation()

  useEffect(() => {
    void checkForNewerBuild('route')
  }, [pathname])

  useEffect(() => {
    const onFocus = () => {
      void checkForNewerBuild('focus')
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkForNewerBuild('focus')
    }
    // The timer runs while hidden and costs nothing there: checkForNewerBuild
    // answers 'hidden' before it reaches the network.
    const timer = window.setInterval(() => {
      void checkForNewerBuild('interval')
    }, POLL_INTERVAL_MS)

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
