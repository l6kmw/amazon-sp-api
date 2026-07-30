import { useState } from 'react'
import styled from '@emotion/styled'
import { Button } from './Button'

export function CopyButton({ textToCopy, label = '复制' }: { textToCopy: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <Button variant="ghost" onClick={handleCopy} type="button" style={{ minHeight: 32, padding: '0 12px' }}>
      {copied ? <CopiedLabel>✓ 已复制</CopiedLabel> : label}
    </Button>
  )
}

const CopiedLabel = styled.span`
  color: ${({ theme }) => theme.colors.success};
`
