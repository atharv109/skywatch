"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      duration={1500}
      offset={20}
      className="toaster group"
      toastOptions={{
        style: {
          background: "#f4f1ea",
          color: "#0c1214",
          border: "none",
          fontSize: "1rem",
          fontWeight: 700,
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
