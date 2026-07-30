import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import styled from '@emotion/styled'
import { Button } from './Button'

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmText = '确认',
  confirmValueToType,
  danger = false,
  onConfirm,
  onClose
}: {
  isOpen: boolean
  title: string
  description: ReactNode
  confirmText?: string
  confirmValueToType?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const [typedValue, setTypedValue] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const inputId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) {
      setTypedValue('')
      dialog.showModal()
    } else if (!isOpen && dialog.open) {
      dialog.close()
    }
  }, [isOpen])

  const canConfirm = !confirmValueToType || typedValue === confirmValueToType

  return (
    <DialogModal
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <DialogContent onClick={(event) => event.stopPropagation()}>
        <Title id={titleId}>{title}</Title>
        <Description>{description}</Description>

        {confirmValueToType ? (
          <InputWrap>
            <InputLabel htmlFor={inputId}>
              输入 <strong>{confirmValueToType}</strong> 以确认执行操作：
            </InputLabel>
            <Input
              id={inputId}
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={confirmValueToType}
            />
          </InputWrap>
        ) : null}

        <Actions>
          <Button autoFocus={!confirmValueToType} variant="secondary" onClick={onClose} type="button">
            取消
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) {
                onConfirm()
                onClose()
              }
            }}
            type="button"
          >
            {confirmText}
          </Button>
        </Actions>
      </DialogContent>
    </DialogModal>
  )
}

const DialogModal = styled.dialog`
  width: min(calc(100% - 2rem), 460px);
  max-width: none;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;

  &::backdrop {
    background: oklch(0% 0 0 / 0.45);
    backdrop-filter: blur(4px);
  }
`

const DialogContent = styled.div`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.lg};
  padding: ${({ theme }) => theme.space.xl};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadows.lift};
`

const Title = styled.h3`
  margin: 0 0 ${({ theme }) => theme.space.sm} 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Description = styled.div`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
  line-height: 1.5;
`

const InputWrap = styled.div`
  margin-top: ${({ theme }) => theme.space.lg};
`

const InputLabel = styled.label`
  display: block;
  font-size: ${({ theme }) => theme.typeScale.small};
  color: ${({ theme }) => theme.colors.text};
  margin-bottom: ${({ theme }) => theme.space.xs};
`

const Input = styled.input`
  width: 100%;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.md};
  padding: ${({ theme }) => theme.space.sm} ${({ theme }) => theme.space.md};
  font-family: ${({ theme }) => theme.fonts.numeric};
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space.md};
  margin-top: ${({ theme }) => theme.space.xl};
`
