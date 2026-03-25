"use client"

import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      richColors
      toastOptions={{
        classNames: {
          toast: "bg-surface-3 border-edge text-text-primary",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
