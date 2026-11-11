import { Component, type ReactNode } from "react";
import { Alert, Button } from "@heroui/react";
import { messageOf } from "@hanskristoffer/taurio/runtime";

/** Keeps a view that throws while rendering, such as one given a board from a newer daemon it cannot read, from
 * blanking the window. Give it a `key` per page so another page starts clean. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: messageOf(error) };
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Alert status="danger" className="callout" role="alert">
        <Alert.Content>
          <Alert.Title>This page could not be shown</Alert.Title>
          <Alert.Description>{this.state.error}</Alert.Description>
        </Alert.Content>
        <Button size="sm" variant="tertiary" onPress={() => this.setState({ error: undefined })}>
          Try again
        </Button>
      </Alert>
    );
  }
}
