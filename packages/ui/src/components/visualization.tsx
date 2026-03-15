import type {
  VisualizationChartSpec,
  VisualizationPayload,
  VisualizationTableRow,
  VisualizationValueFormat,
} from "@rendesk/sdk/v2/client"
import { Card } from "./card"
import { createEffect, createMemo, Match, onCleanup, onMount, Show, splitProps, Switch, type ComponentProps, type JSX } from "solid-js"
import { use as useEcharts, init as initEcharts } from "echarts/core"
import { BarChart, LineChart, PieChart } from "echarts/charts"
import { CanvasRenderer } from "echarts/renderers"
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components"
import type { ECharts, EChartsCoreOption } from "echarts/core"

useEcharts([BarChart, LineChart, PieChart, CanvasRenderer, GridComponent, LegendComponent, TooltipComponent])

const FALLBACK_EMPTY = "No data available."
const CHART_COLORS = ["#6ea7c0", "#7fc8a9", "#e5b77a", "#d08ea6", "#9e9bd8", "#86b5d9"]
const CHART_AXIS = "rgba(255,255,255,0.14)"
const CHART_GRID = "rgba(255,255,255,0.08)"
const CHART_TEXT = "rgba(255,255,255,0.56)"
const CHART_TEXT_STRONG = "rgba(255,255,255,0.84)"
const CHART_TOOLTIP_BG = "rgba(9, 11, 13, 0.96)"
const CHART_TOOLTIP_BORDER = "rgba(255,255,255,0.08)"
const DONUT_BORDER = "rgba(12, 16, 24, 0.95)"

export type VisualizationCardMode = "default" | "expanded"

export function formatVisualizationValue(value: string | number | boolean | null | undefined, format?: VisualizationValueFormat) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value)

  switch (format) {
    case "integer":
      return Math.round(value).toLocaleString()
    case "currency_usd":
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)
    case "percentage":
      return `${value.toFixed(value < 10 ? 1 : 0)}%`
    case "tokens":
    case "compact":
      return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    case "duration_ms":
      if (value < 1_000) return `${Math.round(value)} ms`
      if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`
      return `${(value / 60_000).toFixed(1)} min`
    case "number":
    default:
      return value.toLocaleString()
  }
}

function hasChartData(spec: VisualizationChartSpec) {
  return spec.categories.length > 0 && spec.series.some((series) => series.values.some((value) => typeof value === "number"))
}

function resolveSeriesType(chartType: VisualizationChartSpec["chartType"], seriesType?: VisualizationChartSpec["series"][number]["type"]) {
  if (seriesType === "area") return "line"
  if (seriesType) return seriesType
  if (chartType === "area") return "line"
  if (chartType === "combo") return "line"
  if (chartType === "donut") return "pie"
  return chartType
}

function buildChartOption(spec: VisualizationChartSpec): EChartsCoreOption {
  if (spec.chartType === "donut") {
    const source = spec.series[0]
    return {
      color: CHART_COLORS,
      animationDuration: 240,
      tooltip: {
        trigger: "item",
        backgroundColor: CHART_TOOLTIP_BG,
        borderColor: CHART_TOOLTIP_BORDER,
        borderWidth: 1,
        textStyle: {
          color: CHART_TEXT_STRONG,
          fontSize: 11,
        },
        valueFormatter: (value) =>
          formatVisualizationValue(typeof value === "number" ? value : Number(value), spec.valueFormat),
      },
      legend: {
        bottom: 0,
        itemGap: 10,
        itemWidth: 10,
        itemHeight: 10,
        icon: "circle",
        textStyle: {
          color: CHART_TEXT,
          fontSize: 11,
        },
      },
      series: [
        {
          type: "pie",
          radius: ["54%", "76%"],
          center: ["50%", "44%"],
          itemStyle: {
            borderRadius: 10,
            borderColor: DONUT_BORDER,
            borderWidth: 2,
          },
          label: {
            show: false,
          },
          labelLine: { show: false },
          emphasis: {
            scale: true,
            scaleSize: 6,
          },
          data: spec.categories.map((category, index) => ({
            name: category,
            value: source?.values[index] ?? 0,
          })),
        },
      ],
    }
  }

  const hasRightAxis = spec.series.some((series) => series.axis === "right")
  return {
    color: CHART_COLORS,
    animationDuration: 260,
    animationDurationUpdate: 180,
    grid: {
      top: 20,
      left: 10,
      right: hasRightAxis ? 14 : 10,
      bottom: 18,
      containLabel: true,
    },
    legend: {
      top: 0,
      right: 0,
      itemGap: 10,
      itemWidth: 10,
      itemHeight: 10,
      icon: "circle",
      textStyle: {
        color: CHART_TEXT,
        fontSize: 11,
      },
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: CHART_TOOLTIP_BG,
      borderColor: CHART_TOOLTIP_BORDER,
      borderWidth: 1,
      textStyle: {
        color: CHART_TEXT_STRONG,
        fontSize: 11,
      },
      axisPointer: {
        type: spec.chartType === "bar" ? "shadow" : "line",
        lineStyle: {
          color: "rgba(255,255,255,0.22)",
          width: 1,
        },
        shadowStyle: {
          color: "rgba(255,255,255,0.04)",
        },
      },
      valueFormatter: (value) =>
        formatVisualizationValue(
          typeof value === "number" ? value : Number(value),
          spec.secondaryValueFormat && hasRightAxis ? spec.secondaryValueFormat : spec.valueFormat,
        ),
    },
    xAxis: {
      type: "category",
      data: spec.categories,
      axisTick: { show: false },
      axisLine: {
        lineStyle: {
          color: CHART_AXIS,
        },
      },
      axisLabel: {
        color: CHART_TEXT,
        fontSize: 11,
      },
    },
    yAxis: [
      {
        type: "value",
        axisLine: { show: false },
        splitLine: {
          lineStyle: {
            color: CHART_GRID,
          },
        },
        axisLabel: {
          color: CHART_TEXT,
          fontSize: 11,
          formatter: (value: number) => formatVisualizationValue(value, spec.valueFormat),
        },
      },
      ...(hasRightAxis
        ? [
            {
              type: "value",
              axisLine: { show: false },
              splitLine: { show: false },
              axisLabel: {
                color: CHART_TEXT,
                fontSize: 11,
                formatter: (value: number) => formatVisualizationValue(value, spec.secondaryValueFormat ?? spec.valueFormat),
              },
            },
          ]
        : []),
    ],
    series: spec.series.map((series, index) => ({
      name: series.label,
      type: resolveSeriesType(spec.chartType, series.type),
      data: series.values,
      yAxisIndex: series.axis === "right" ? 1 : 0,
      stack: series.stack,
      showSymbol: false,
      smooth: series.type !== "bar",
      emphasis: { focus: "series" },
      barMaxWidth: 28,
      lineStyle: {
        width: 2,
      },
      areaStyle:
        series.type === "area" || (spec.chartType === "area" && !series.type)
          ? {
              opacity: 1,
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: `${series.color ?? CHART_COLORS[index % CHART_COLORS.length]}88` },
                  { offset: 1, color: `${series.color ?? CHART_COLORS[index % CHART_COLORS.length]}08` },
                ],
              },
            }
          : undefined,
      itemStyle: {
        color: series.color ?? CHART_COLORS[index % CHART_COLORS.length],
        borderRadius: resolveSeriesType(spec.chartType, series.type) === "bar" ? [8, 8, 3, 3] : undefined,
      },
    })),
  }
}

function EmptyState(props: { text?: string; mode?: VisualizationCardMode }) {
  return (
    <div
      class="flex items-center justify-center rounded-[14px] border border-dashed border-border-weaker-base/80 bg-transparent text-13-regular text-text-weak"
      classList={{
        "min-h-[220px]": props.mode !== "expanded",
        "min-h-[420px]": props.mode === "expanded",
      }}
    >
      {props.text ?? FALLBACK_EMPTY}
    </div>
  )
}

function VisualizationChart(props: { spec: VisualizationChartSpec; mode?: VisualizationCardMode }) {
  let ref: HTMLDivElement | undefined
  let chart: ECharts | undefined
  let resizeObserver: ResizeObserver | undefined

  const option = createMemo(() => buildChartOption(props.spec))

  onMount(() => {
    if (!ref) return
    chart = initEcharts(ref, undefined, { renderer: "canvas" })
    chart.setOption(option())
    resizeObserver = new ResizeObserver(() => chart?.resize())
    resizeObserver.observe(ref)
  })

  createEffect(() => {
    if (!chart) return
    chart.setOption(option(), true)
  })

  onCleanup(() => {
    resizeObserver?.disconnect()
    chart?.dispose()
    chart = undefined
  })

  return (
    <Show when={hasChartData(props.spec)} fallback={<EmptyState text={props.spec.emptyState ?? FALLBACK_EMPTY} mode={props.mode} />}>
      <div
        ref={ref}
        class="w-full"
        classList={{
          "h-[260px]": props.mode !== "expanded",
          "h-[420px] lg:h-[520px]": props.mode === "expanded",
        }}
      />
    </Show>
  )
}

function metricChangeTone(change?: number) {
  if (change === undefined || change === 0) return "text-text-weak"
  if (change > 0) return "text-emerald-300"
  return "text-rose-300"
}

function VisualizationMetrics(props: { spec: Extract<VisualizationPayload, { kind: "metrics" }>; mode?: VisualizationCardMode }) {
  return (
    <Show when={props.spec.items.length > 0} fallback={<EmptyState text={FALLBACK_EMPTY} mode={props.mode} />}>
      <div
        class="grid gap-x-8 gap-y-6"
        classList={{
          "sm:grid-cols-2 xl:grid-cols-4": props.mode !== "expanded",
          "lg:grid-cols-2 2xl:grid-cols-4": props.mode === "expanded",
        }}
      >
        {props.spec.items.map((item) => (
          <div class="min-w-0 border-l border-border-weaker-base/80 pl-4 first:border-l-0 first:pl-0">
            <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">{item.label}</div>
            <div class="pt-2 text-[30px] font-semibold leading-none tracking-[-0.03em] text-text-strong">
              {formatVisualizationValue(item.value, item.format)}
            </div>
            <Show when={item.change !== undefined || item.note}>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-12-regular text-text-weak">
                <Show when={item.change !== undefined}>
                  <span class={metricChangeTone(item.change)}>
                    {`${item.change! > 0 ? "+" : ""}${formatVisualizationValue(item.change, "percentage")}`}
                  </span>
                </Show>
                <Show when={item.note}>
                  <span>{item.note}</span>
                </Show>
              </div>
            </Show>
          </div>
        ))}
      </div>
    </Show>
  )
}

function tableCell(row: VisualizationTableRow, key: string) {
  return row[key]
}

function VisualizationTable(props: { spec: Extract<VisualizationPayload, { kind: "table" }>; mode?: VisualizationCardMode }) {
  return (
    <Show when={props.spec.rows.length > 0} fallback={<EmptyState text={props.spec.emptyState ?? FALLBACK_EMPTY} mode={props.mode} />}>
      <div
        class="overflow-auto rounded-[12px]"
        classList={{
          "max-h-[320px]": props.mode !== "expanded",
          "max-h-[560px]": props.mode === "expanded",
        }}
      >
        <table class="min-w-full border-collapse">
          <thead>
            <tr class="border-b border-border-weaker-base/90">
              {props.spec.columns.map((column) => (
                <th class="px-4 py-3 text-left text-11-medium uppercase tracking-[0.08em] text-text-weak first:pl-0 last:pr-0">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.spec.rows.map((row) => (
              <tr class="border-b border-border-weaker-base/70 last:border-b-0">
                {props.spec.columns.map((column) => (
                  <td
                    class="px-4 py-3 text-13-regular text-text-strong first:pl-0 last:pr-0"
                    style={{ "text-align": column.align ?? "left" }}
                  >
                    {formatVisualizationValue(tableCell(row, column.key), column.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Show>
  )
}

export interface VisualizationCardProps extends ComponentProps<typeof Card> {
  visualization: VisualizationPayload
  actions?: JSX.Element
  meta?: JSX.Element
  hideHeader?: boolean
  mode?: VisualizationCardMode
}

export function VisualizationCard(props: VisualizationCardProps) {
  const [local, rest] = splitProps(props, ["visualization", "actions", "meta", "hideHeader", "mode", "class", "classList"])
  const title = createMemo(() => local.visualization.title)
  const description = createMemo(() => local.visualization.description)

  return (
    <Card
      {...rest}
      class={`overflow-hidden rounded-[16px] border border-border-weaker-base bg-background-base p-0 shadow-[0_14px_38px_rgba(0,0,0,0.14)] ${local.mode === "expanded" ? "h-full" : ""} ${local.class ?? ""}`}
      classList={local.classList}
    >
      <section class="flex h-full w-full flex-col">
        <Show when={!local.hideHeader && (title() || description() || local.meta || local.actions)}>
          <div class="flex flex-wrap items-start justify-between gap-4 border-b border-border-weaker-base/80 px-5 py-4">
            <div class="min-w-0 flex-1">
              <Show when={title()}>
                <div class="truncate text-14-medium tracking-[-0.015em] text-text-strong">{title()}</div>
              </Show>
              <Show when={description()}>
                <div class="pt-1 text-12-regular leading-6 text-text-weak">{description()}</div>
              </Show>
              <Show when={local.meta}>
                <div class="flex flex-wrap items-center gap-2 pt-3">{local.meta}</div>
              </Show>
            </div>
            <Show when={local.actions}>
              <div class="flex shrink-0 items-center gap-2">{local.actions}</div>
            </Show>
          </div>
        </Show>
        <div
          class="min-h-0 flex-1"
          classList={{
            "px-5 py-5": local.mode !== "expanded",
            "px-5 py-5 lg:px-6 lg:py-6": local.mode === "expanded",
          }}
        >
          <Switch>
            <Match when={local.visualization.kind === "chart"}>
              <VisualizationChart spec={local.visualization as VisualizationChartSpec} mode={local.mode} />
            </Match>
            <Match when={local.visualization.kind === "metrics"}>
              <VisualizationMetrics spec={local.visualization as Extract<VisualizationPayload, { kind: "metrics" }>} mode={local.mode} />
            </Match>
            <Match when={local.visualization.kind === "table"}>
              <VisualizationTable spec={local.visualization as Extract<VisualizationPayload, { kind: "table" }>} mode={local.mode} />
            </Match>
          </Switch>
        </div>
      </section>
    </Card>
  )
}
