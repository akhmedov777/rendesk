import {
  type BaseRouterProps,
  type LocationChange,
  createBeforeLeave,
  createRouter,
  keepDepth,
  notifyIfNotBlocked,
  saveCurrentDepth,
} from "@solidjs/router"

const ROUTE_QUERY_KEY = "route"
const ROUTER_ORIGIN = "https://rendesk.invalid"

const bindEvent = (target: EventTarget, type: string, handler: EventListener) => {
  target.addEventListener(type, handler)
  return () => target.removeEventListener(type, handler)
}

const scrollToHash = (hash: string, fallbackTop?: boolean) => {
  const element = hash ? document.getElementById(hash) : null
  if (element) {
    element.scrollIntoView()
    return
  }
  if (fallbackTop) window.scrollTo(0, 0)
}

const normalizeRoute = (value: string | null | undefined) => {
  if (!value) return "/"
  return value.startsWith("/") ? value : `/${value.replace(/^\/+/, "")}`
}

const readRoute = () => {
  const params = new URLSearchParams(window.location.search)
  return normalizeRoute(params.get(ROUTE_QUERY_KEY))
}

const stateFromHistory = () => {
  const state = window.history.state
  return state && state._depth && Object.keys(state).length === 1 ? undefined : state
}

const buildHistoryUrl = (value: string) => {
  const nextRoute = new URL(value, ROUTER_ORIGIN)
  const params = new URLSearchParams(window.location.search)
  params.set(ROUTE_QUERY_KEY, `${nextRoute.pathname}${nextRoute.search}`)
  const search = params.toString()
  return `${window.location.pathname}${search ? `?${search}` : ""}${nextRoute.hash}`
}

export function DesktopRouter(props: BaseRouterProps) {
  const getSource = () => ({
    value: `${readRoute()}${window.location.hash}`,
    state: stateFromHistory(),
  })

  const beforeLeave = createBeforeLeave()

  return createRouter({
    get: getSource,
    set({ value, replace, scroll, state }: LocationChange) {
      const next = buildHistoryUrl(value)
      if (replace) {
        window.history.replaceState(keepDepth(state), "", next)
      } else {
        window.history.pushState(state, "", next)
      }
      scrollToHash(decodeURIComponent(window.location.hash.slice(1)), scroll)
      saveCurrentDepth()
    },
    init: (notify: (value?: string | LocationChange) => void) =>
      bindEvent(
        window,
        "popstate",
        notifyIfNotBlocked(notify, (delta) => {
          if (delta) {
            return !beforeLeave.confirm(delta)
          }
          const source = getSource()
          return !beforeLeave.confirm(source.value, { state: source.state })
        }),
      ),
    utils: {
      go: (delta: number) => window.history.go(delta),
      beforeLeave,
      renderPath: (path: string) => {
        const rendered = new URL(path, ROUTER_ORIGIN)
        const params = new URLSearchParams(window.location.search)
        params.set(ROUTE_QUERY_KEY, `${rendered.pathname}${rendered.search}`)
        const search = params.toString()
        return `${window.location.pathname}${search ? `?${search}` : ""}${rendered.hash}`
      },
      parsePath: (path: string) => {
        const parsed = new URL(path, window.location.href)
        return `${normalizeRoute(parsed.searchParams.get(ROUTE_QUERY_KEY))}${parsed.hash}`
      },
    },
  })(props)
}
