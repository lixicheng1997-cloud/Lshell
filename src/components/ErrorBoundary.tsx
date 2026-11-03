import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * 全局错误边界。
 *
 * React 在渲染期抛错时会卸载整棵组件树，用户看到的就是一片空白，
 * 什么线索都留不下。这个边界把错误信息显示出来，
 * 至少让人知道是哪里出的问题，而不是对着白屏发呆。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, stack: info.componentStack ?? "" });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-card">
          <h1>界面出错了</h1>
          <p className="crash-msg">{error.message}</p>
          {stack && <pre className="crash-stack">{stack.trim()}</pre>}
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
