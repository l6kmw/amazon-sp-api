import { Component, type ReactNode } from 'react'
import styled from '@emotion/styled'
import { Button } from './components/Button'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false }

  public static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  private handleReset = () => {
    this.setState({ hasError: false })
    window.location.hash = '#/'
  }

  public render() {
    if (this.state.hasError) {
      return (
        <ErrorContainer>
          <ErrorCard>
            <Title>控制台出现意外错误</Title>
            <Message>页面无法继续显示。为避免泄露响应细节，错误内容未写入 DOM 或控制台。</Message>
            <Actions>
              <Button onClick={this.handleReset} type="button">
                返回首页
              </Button>
            </Actions>
          </ErrorCard>
        </ErrorContainer>
      )
    }

    return this.props.children
  }
}

const ErrorContainer = styled.div`
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: ${({ theme }) => theme.space.lg};
  background: ${({ theme }) => theme.colors.background};
`

const ErrorCard = styled.div`
  width: min(100%, 480px);
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radii.lg};
  padding: ${({ theme }) => theme.space.xl};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadows.lift};
  text-align: center;
`

const Title = styled.h2`
  margin: 0 0 ${({ theme }) => theme.space.md} 0;
  color: ${({ theme }) => theme.colors.danger};
  font-size: ${({ theme }) => theme.typeScale.title};
`

const Message = styled.p`
  margin: 0 0 ${({ theme }) => theme.space.xl} 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.typeScale.small};
`

const Actions = styled.div`
  display: flex;
  justify-content: center;
`
