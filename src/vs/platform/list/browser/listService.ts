/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { ITree, ITreeConfiguration, ITreeOptions } from 'vs/base/parts/tree/browser/tree';
import { List, IListOptions, isSelectionRangeChangeEvent, isSelectionSingleChangeEvent, IMultipleSelectionController, IOpenController } from 'vs/base/browser/ui/list/listWidget';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IDisposable, toDisposable, combinedDisposable, dispose, Disposable } from 'vs/base/common/lifecycle';
import { IContextKeyService, IContextKey, RawContextKey, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { PagedList, IPagedRenderer } from 'vs/base/browser/ui/list/listPaging';
import { IDelegate, IRenderer, IListMouseEvent, IListTouchEvent } from 'vs/base/browser/ui/list/list';
import { Tree } from 'vs/base/parts/tree/browser/treeImpl';
import { attachListStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { InputFocusedContextKey } from 'vs/platform/workbench/common/contextkeys';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { mixin } from 'vs/base/common/objects';
import { localize } from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { DefaultController, IControllerOptions, OpenMode } from 'vs/base/parts/tree/browser/treeDefaults';
import { isUndefinedOrNull } from 'vs/base/common/types';
import { IEditorOptions } from 'vs/platform/editor/common/editor';
import Event, { Emitter } from 'vs/base/common/event';
export type ListWidget = List<any> | PagedList<any> | ITree;

export const IListService = createDecorator<IListService>('listService');

export interface IListService {

	_serviceBrand: any;

	/**
	 * Returns the currently focused list widget if any.
	 */
	readonly lastFocusedList: ListWidget | undefined;
}

interface IRegisteredList {
	widget: ListWidget;
	extraContextKeys?: (IContextKey<boolean>)[];
}

export class ListService implements IListService {

	_serviceBrand: any;

	private lists: IRegisteredList[] = [];
	private _lastFocusedWidget: ListWidget | undefined = undefined;

	get lastFocusedList(): ListWidget | undefined {
		return this._lastFocusedWidget;
	}

	constructor( @IContextKeyService contextKeyService: IContextKeyService) { }

	register(widget: ListWidget, extraContextKeys?: (IContextKey<boolean>)[]): IDisposable {
		if (this.lists.some(l => l.widget === widget)) {
			throw new Error('Cannot register the same widget multiple times');
		}

		// Keep in our lists list
		const registeredList: IRegisteredList = { widget, extraContextKeys };
		this.lists.push(registeredList);

		// Check for currently being focused
		if (widget.isDOMFocused()) {
			this._lastFocusedWidget = widget;
		}

		const result = combinedDisposable([
			widget.onDidFocus(() => this._lastFocusedWidget = widget),
			toDisposable(() => this.lists.splice(this.lists.indexOf(registeredList), 1))
		]);

		return result;
	}
}

const RawWorkbenchListFocusContextKey = new RawContextKey<boolean>('listFocus', true);
export const WorkbenchListSupportsMultiSelectContextKey = new RawContextKey<boolean>('listSupportsMultiselect', true);
export const WorkbenchListFocusContextKey = ContextKeyExpr.and(RawWorkbenchListFocusContextKey, ContextKeyExpr.not(InputFocusedContextKey));
export const WorkbenchListDoubleSelection = new RawContextKey<boolean>('listDoubleSelection', false);

export type Widget = List<any> | PagedList<any> | ITree;

function createScopedContextKeyService(contextKeyService: IContextKeyService, widget: Widget): IContextKeyService {
	const result = contextKeyService.createScoped(widget.getHTMLElement());

	if (widget instanceof List || widget instanceof PagedList) {
		WorkbenchListSupportsMultiSelectContextKey.bindTo(result);
	}

	RawWorkbenchListFocusContextKey.bindTo(result);
	return result;
}

export const multiSelectModifierSettingKey = 'workbench.list.multiSelectModifier';
export const openModeSettingKey = 'workbench.list.openMode';

function useAltAsMultipleSelectionModifier(configurationService: IConfigurationService): boolean {
	return configurationService.getValue(multiSelectModifierSettingKey) === 'alt';
}

function useSingleClickToOpen(configurationService: IConfigurationService): boolean {
	return configurationService.getValue(openModeSettingKey) !== 'doubleClick';
}

class MultipleSelectionController<T> implements IMultipleSelectionController<T> {

	constructor(private configurationService: IConfigurationService) { }

	isSelectionSingleChangeEvent(event: IListMouseEvent<T> | IListTouchEvent<T>): boolean {
		if (useAltAsMultipleSelectionModifier(this.configurationService)) {
			return event.browserEvent.altKey;
		}

		return isSelectionSingleChangeEvent(event);
	}

	isSelectionRangeChangeEvent(event: IListMouseEvent<T> | IListTouchEvent<T>): boolean {
		return isSelectionRangeChangeEvent(event);
	}
}

class OpenController implements IOpenController {

	constructor(private configurationService: IConfigurationService) { }

	shouldOpen(event: UIEvent): boolean {
		if (event instanceof MouseEvent) {
			const isDoubleClick = event.detail === 2;

			return useSingleClickToOpen(this.configurationService) || isDoubleClick;
		}

		return true;
	}
}

function handleListControllers<T>(options: IListOptions<T>, configurationService: IConfigurationService): IListOptions<T> {
	if (options.multipleSelectionSupport === true && !options.multipleSelectionController) {
		options.multipleSelectionController = new MultipleSelectionController(configurationService);
	}

	options.openController = new OpenController(configurationService);

	return options;
}

export class WorkbenchList<T> extends List<T> {

	readonly contextKeyService: IContextKeyService;

	private listDoubleSelection: IContextKey<boolean>;

	private _useAltAsMultipleSelectionModifier: boolean;

	constructor(
		container: HTMLElement,
		delegate: IDelegate<T>,
		renderers: IRenderer<T, any>[],
		options: IListOptions<T>,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService listService: IListService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(container, delegate, renderers, mixin(handleListControllers(options, configurationService), { keyboardSupport: false } as IListOptions<any>, false));

		this.contextKeyService = createScopedContextKeyService(contextKeyService, this);
		this.listDoubleSelection = WorkbenchListDoubleSelection.bindTo(this.contextKeyService);

		this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(configurationService);

		this.disposables.push(combinedDisposable([
			this.contextKeyService,
			(listService as ListService).register(this),
			attachListStyler(this, themeService),
			this.onSelectionChange(() => this.listDoubleSelection.set(this.getSelection().length === 2))
		]));

		this.registerListeners();
	}

	public get useAltAsMultipleSelectionModifier(): boolean {
		return this._useAltAsMultipleSelectionModifier;
	}

	private registerListeners(): void {
		this.disposables.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(multiSelectModifierSettingKey)) {
				this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(this.configurationService);
			}
		}));
	}
}

export class WorkbenchPagedList<T> extends PagedList<T> {

	readonly contextKeyService: IContextKeyService;

	private disposables: IDisposable[] = [];

	private _useAltAsMultipleSelectionModifier: boolean;

	constructor(
		container: HTMLElement,
		delegate: IDelegate<number>,
		renderers: IPagedRenderer<T, any>[],
		options: IListOptions<any>,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService listService: IListService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(container, delegate, renderers, mixin(handleListControllers(options, configurationService), { keyboardSupport: false } as IListOptions<any>, false));

		this.contextKeyService = createScopedContextKeyService(contextKeyService, this);

		this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(configurationService);

		this.disposables.push(combinedDisposable([
			this.contextKeyService,
			(listService as ListService).register(this),
			attachListStyler(this, themeService)
		]));

		this.registerListeners();
	}

	public get useAltAsMultipleSelectionModifier(): boolean {
		return this._useAltAsMultipleSelectionModifier;
	}

	private registerListeners(): void {
		this.disposables.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(multiSelectModifierSettingKey)) {
				this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(this.configurationService);
			}
		}));
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

export class WorkbenchTree extends Tree {

	readonly contextKeyService: IContextKeyService;

	protected disposables: IDisposable[] = [];

	private listDoubleSelection: IContextKey<boolean>;

	private _openOnSingleClick: boolean;
	private _useAltAsMultipleSelectionModifier: boolean;

	constructor(
		container: HTMLElement,
		configuration: ITreeConfiguration,
		options: ITreeOptions,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IListService listService: IListService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(container, configuration, mixin(options, { keyboardSupport: false } as ITreeOptions, false));

		this.contextKeyService = createScopedContextKeyService(contextKeyService, this);
		this.listDoubleSelection = WorkbenchListDoubleSelection.bindTo(this.contextKeyService);

		this._openOnSingleClick = useSingleClickToOpen(configurationService);
		this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(configurationService);

		this.disposables.push(
			this.contextKeyService,
			(listService as ListService).register(this),
			attachListStyler(this, themeService)
		);

		this.registerListeners();
	}

	public get openOnSingleClick(): boolean {
		return this._openOnSingleClick;
	}

	public get useAltAsMultipleSelectionModifier(): boolean {
		return this._useAltAsMultipleSelectionModifier;
	}

	private registerListeners(): void {
		this.disposables.push(this.onDidChangeSelection(() => {
			const selection = this.getSelection();
			this.listDoubleSelection.set(selection && selection.length === 2);
		}));

		this.disposables.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(openModeSettingKey)) {
				this._openOnSingleClick = useSingleClickToOpen(this.configurationService);
			}

			if (e.affectsConfiguration(multiSelectModifierSettingKey)) {
				this._useAltAsMultipleSelectionModifier = useAltAsMultipleSelectionModifier(this.configurationService);
			}
		}));
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

export class WorkbenchTreeController extends DefaultController {

	protected disposables: IDisposable[] = [];

	constructor(
		options: IControllerOptions,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(options);

		// if the open mode is not set, we configure it based on settings
		if (isUndefinedOrNull(options.openMode)) {
			this.setOpenMode(this.getOpenModeSetting());
			this.registerListeners();
		}
	}

	private registerListeners(): void {
		this.disposables.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(openModeSettingKey)) {
				this.setOpenMode(this.getOpenModeSetting());
			}
		}));
	}

	private getOpenModeSetting(): OpenMode {
		return useSingleClickToOpen(this.configurationService) ? OpenMode.SINGLE_CLICK : OpenMode.DOUBLE_CLICK;
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

export interface IOpenResourceOptions {
	editorOptions: IEditorOptions;
	sideBySide: boolean;
	element: any;
	payload: any;
}

export interface IResourceResultsNavigationOptions {
	openOnFocus: boolean;
}

export default class ResourceResultsNavigation extends Disposable {

	private _openResource: Emitter<IOpenResourceOptions> = new Emitter<IOpenResourceOptions>();
	public readonly openResource: Event<IOpenResourceOptions> = this._openResource.event;

	constructor(private tree: WorkbenchTree, private options?: IResourceResultsNavigationOptions) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		if (this.options && this.options.openOnFocus) {
			this._register(this.tree.onDidChangeFocus(e => this.onFocus(e)));
		}

		this._register(this.tree.onDidChangeSelection(e => this.onSelection(e)));
	}

	private onFocus({ payload }: any): void {
		const element = this.tree.getFocus();
		this.tree.setSelection([element], { fromFocus: true });

		const originalEvent: KeyboardEvent | MouseEvent = payload && payload.originalEvent;
		const isMouseEvent = payload && payload.origin === 'mouse';
		const isDoubleClick = isMouseEvent && originalEvent && originalEvent.detail === 2;

		if (!isMouseEvent || this.tree.openOnSingleClick || isDoubleClick) {
			this._openResource.fire({
				editorOptions: {
					preserveFocus: true,
					pinned: false,
					revealIfVisible: true
				},
				sideBySide: false,
				element,
				payload
			});
		}
	}

	private onSelection({ payload }: any): void {
		if (payload && payload.fromFocus) {
			return;
		}

		const originalEvent: KeyboardEvent | MouseEvent = payload && payload.originalEvent;
		const isMouseEvent = payload && payload.origin === 'mouse';
		const isDoubleClick = isMouseEvent && originalEvent && originalEvent.detail === 2;

		if (!isMouseEvent || this.tree.openOnSingleClick || isDoubleClick) {
			if (isDoubleClick && originalEvent) {
				originalEvent.preventDefault(); // focus moves to editor, we need to prevent default
			}

			const isFromKeyboard = payload && payload.origin === 'keyboard';
			const sideBySide = (originalEvent && (originalEvent.ctrlKey || originalEvent.metaKey || originalEvent.altKey));
			const preserveFocus = !((isFromKeyboard && (!payload || !payload.preserveFocus)) || isDoubleClick || (payload && payload.focusEditor));
			this._openResource.fire({
				editorOptions: {
					preserveFocus,
					pinned: isDoubleClick,
					revealIfVisible: true
				},
				sideBySide,
				element: this.tree.getSelection()[0],
				payload
			});
		}
	}
}

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

configurationRegistry.registerConfiguration({
	'id': 'workbench',
	'order': 7,
	'title': localize('workbenchConfigurationTitle', "Workbench"),
	'type': 'object',
	'properties': {
		'workbench.list.multiSelectModifier': {
			'type': 'string',
			'enum': ['ctrlCmd', 'alt'],
			'enumDescriptions': [
				localize('multiSelectModifier.ctrlCmd', "Maps to `Control` on Windows and Linux and to `Command` on macOS."),
				localize('multiSelectModifier.alt', "Maps to `Alt` on Windows and Linux and to `Option` on macOS.")
			],
			'default': 'ctrlCmd',
			'description': localize({
				key: 'multiSelectModifier',
				comment: [
					'- `ctrlCmd` refers to a value the setting can take and should not be localized.',
					'- `Control` and `Command` refer to the modifier keys Ctrl or Cmd on the keyboard and can be localized.'
				]
			}, "The modifier to be used to add an item in trees and lists to a multi-selection with the mouse (if supported). `ctrlCmd` maps to `Control` on Windows and Linux and to `Command` on macOS. The 'Open to Side' mouse gestures - if supported - will adapt such that they do not conflict with the multiselect modifier.")
		},
		'workbench.list.openMode': {
			'type': 'string',
			'enum': ['singleClick', 'doubleClick'],
			'enumDescriptions': [
				localize('openMode.singleClick', "Opens items on mouse single click."),
				localize('openMode.doubleClick', "Open items on mouse double click.")
			],
			'default': 'singleClick',
			'description': localize({
				key: 'openModeModifier',
				comment: ['`singleClick` and `doubleClick` refers to a value the setting can take and should not be localized.']
			}, "Controls how to open items in trees and lists using the mouse (if supported). Set to `singleClick` to open items with a single mouse click and `doubleClick` to only open via mouse double click.")
		}
	}
});