"use client"

import { useTheme } from "@/contexts/ThemeContext"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme}
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
