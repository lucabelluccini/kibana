/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { AuthenticatedUser, NotificationsStart } from '@kbn/core/public';
import { i18n } from '@kbn/i18n';
import { pull } from 'lodash';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useObservable from 'react-use/lib/useObservable';
import { v4 } from 'uuid';
import type { GlobalWidgetParameters } from '../..';
import type { InvestigateWidget, InvestigateWidgetCreate, Investigation } from '../../../common';
import type { WidgetDefinition } from '../../types';
import {
  InvestigateWidgetApiContextProvider,
  UseInvestigateWidgetApi,
} from '../use_investigate_widget';
import { useLocalStorage } from '../use_local_storage';
import { createNewInvestigation } from './create_new_investigation';
import { StatefulInvestigation, createInvestigationStore } from './investigation_store';

export type RenderableInvestigateWidget = InvestigateWidget & {
  loading: boolean;
  element: React.ReactNode;
};

export type RenderableInvestigation = Omit<StatefulInvestigation, 'items'> & {
  items: RenderableInvestigateWidget[];
};

export interface UseInvestigationApi {
  investigations: Investigation[];
  investigation?: StatefulInvestigation;
  renderableInvestigation?: RenderableInvestigation;
  copyItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  addItem: (options: InvestigateWidgetCreate) => Promise<void>;
  setGlobalParameters: (parameters: GlobalWidgetParameters) => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  addNote: (note: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
}

function useInvestigationWithoutContext({
  user,
  notifications,
  widgetDefinitions,
  from,
  to,
}: {
  user: AuthenticatedUser;
  notifications: NotificationsStart;
  widgetDefinitions: WidgetDefinition[];
  from: string;
  to: string;
}): UseInvestigationApi {
  const [investigationStore, _] = useState(() =>
    createInvestigationStore({
      user,
      widgetDefinitions,
      investigation: createNewInvestigation({
        user,
        id: v4(),
        globalWidgetParameters: {
          timeRange: {
            from,
            to,
          },
        },
      }),
    })
  );

  const investigation$ = investigationStore.asObservable();
  const investigation = useObservable(investigation$)?.investigation;

  const addItem = async (widget: InvestigateWidgetCreate) => {
    try {
      const id = v4();
      await investigationStore.addItem(id, widget);
    } catch (error) {
      notifications.showErrorDialog({
        title: i18n.translate('xpack.investigate.failedToAddWidget', {
          defaultMessage: 'Failed to add widget',
        }),
        error,
      });
    }
  };

  const deleteItem = async (id: string) => {
    return investigationStore.deleteItem(id);
  };

  const widgetComponentsById = useRef<
    Record<string, React.ComponentType<{ widget: InvestigateWidget }>>
  >({});

  const itemsWithContext = useMemo(() => {
    const unusedComponentIds = Object.keys(widgetComponentsById);

    const nextItemsWithContext =
      investigation?.items.map((item) => {
        let Component = widgetComponentsById.current[item.id];
        if (!Component) {
          const id = item.id;
          const api: UseInvestigateWidgetApi = {
            onWidgetAdd: async (create) => {
              return investigationStore.addItem(item.id, create);
            },
          };

          const onDelete = () => {
            return investigationStore.deleteItem(id);
          };

          const widgetDefinition = widgetDefinitions.find(
            (definition) => definition.type === item.type
          )!;

          Component = widgetComponentsById.current[id] = (props) => {
            return (
              <InvestigateWidgetApiContextProvider value={api}>
                {widgetDefinition
                  ? widgetDefinition.render({
                      onWidgetAdd: api.onWidgetAdd,
                      onDelete,
                      widget: props.widget,
                    })
                  : undefined}
              </InvestigateWidgetApiContextProvider>
            );
          };
        }

        pull(unusedComponentIds, item.id);

        return {
          ...item,
          Component,
        };
      }) ?? [];

    unusedComponentIds.forEach((id) => {
      delete widgetComponentsById.current[id];
    });

    return nextItemsWithContext;
  }, [investigation?.items, widgetDefinitions, investigationStore]);

  const renderableInvestigation = useMemo(() => {
    return investigation
      ? {
          ...investigation,
          items: itemsWithContext.map((item) => {
            const { Component, ...rest } = item;
            return {
              ...rest,
              element: <Component widget={item} />,
            };
          }),
        }
      : undefined;
  }, [investigation, itemsWithContext]);

  const { copyItem, setGlobalParameters, setTitle } = investigationStore;

  const { storedItem: investigations, setStoredItem: setInvestigations } = useLocalStorage<
    Investigation[]
  >('experimentalInvestigations', []);

  const investigationsRef = useRef(investigations);
  investigationsRef.current = investigations;

  useEffect(() => {
    function attemptToStoreInvestigations(next: Investigation[]) {
      try {
        setInvestigations(next);
      } catch (error) {
        notifications.showErrorDialog({
          title: i18n.translate('xpack.investigate.useInvestigation.errorSavingInvestigations', {
            defaultMessage: 'Could not save investigations to local storage',
          }),
          error,
        });
      }
    }

    const subscription = investigation$.subscribe(({ investigation: investigationFromStore }) => {
      const isEmpty = investigationFromStore.items.length === 0;

      if (isEmpty) {
        return;
      }

      const toSerialize = {
        ...investigationFromStore,
        items: investigationFromStore.items.map((item) => {
          const { loading, ...rest } = item;
          return rest;
        }),
      };

      const hasStoredCurrentInvestigation = !!investigationsRef.current.find(
        (investigationAtIndex) => investigationAtIndex.id === investigationFromStore.id
      );

      if (!hasStoredCurrentInvestigation) {
        attemptToStoreInvestigations([...(investigationsRef.current ?? []), toSerialize].reverse());
        return;
      }

      const nextInvestigations = investigationsRef.current
        .map((investigationAtIndex) => {
          if (investigationAtIndex.id === investigationFromStore.id) {
            return toSerialize;
          }
          return investigationAtIndex;
        })
        .reverse();

      attemptToStoreInvestigations(nextInvestigations);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [investigation$, setInvestigations, notifications]);

  const addNote = async (note: string) => {
    await investigationStore.addNote(note);
  };

  const deleteNote = async (id: string) => {
    await investigationStore.deleteNote(id);
  };

  return {
    addNote,
    deleteNote,
    addItem,
    copyItem,
    deleteItem,
    investigation,
    renderableInvestigation,
    setGlobalParameters,
    setTitle,
    investigations,
  };
}

export function createUseInvestigation({
  notifications,
  widgetDefinitions,
}: {
  notifications: NotificationsStart;
  widgetDefinitions: WidgetDefinition[];
}) {
  return ({ user, from, to }: { user: AuthenticatedUser; from: string; to: string }) => {
    return useInvestigationWithoutContext({
      user,
      notifications,
      widgetDefinitions,
      from,
      to,
    });
  };
}
