import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-mark-stem" d="M2 0H6V20H2V0Z" fill="var(--icon-strong-base)" />
      <path
        data-slot="logo-mark-bowl"
        d="M6 0H10C13.3137 0 16 2.68629 16 6C16 9.31371 13.3137 12 10 12H6V8.6H9.5C10.8807 8.6 12 7.48071 12 6.1C12 4.71929 10.8807 3.6 9.5 3.6H6V0Z"
        fill="var(--icon-weak-base)"
      />
      <path data-slot="logo-mark-leg" d="M6.8 10.8H11.6L15.4 20H11.2L6.8 10.8Z" fill="var(--icon-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M10 0H30V100H10V0Z" fill="var(--icon-strong-base)" />
      <path
        d="M30 0H50C66.5685 0 80 13.4315 80 30C80 46.5685 66.5685 60 50 60H30V43H47.5C54.4036 43 60 37.4036 60 30.5C60 23.5964 54.4036 18 47.5 18H30V0Z"
        fill="var(--icon-weak-base)"
      />
      <path d="M34 54H58L77 100H56L34 54Z" fill="var(--icon-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 220 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(0 1)">
        <path d="M2 0H6V36H2V0Z" fill="var(--icon-strong-base)" />
        <path
          d="M6 0H10C13.3137 0 16 2.68629 16 6C16 9.31371 13.3137 12 10 12H6V8.6H9.5C10.8807 8.6 12 7.48071 12 6.1C12 4.71929 10.8807 3.6 9.5 3.6H6V0Z"
          fill="var(--icon-weak-base)"
        />
        <path d="M6.8 10.8H11.6L15.4 20H11.2L6.8 10.8Z" fill="var(--icon-base)" />
      </g>
      <text
        x="28"
        y="28"
        fill="var(--icon-strong-base)"
        style={{ "font-family": "var(--font-family-sans), sans-serif", "font-size": "24px", "font-weight": 700 }}
      >
        Rendesk
      </text>
    </svg>
  )
}
